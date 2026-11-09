/**
 * TurnInterpreter — turns the AI's reply for one turn into a decision.
 *
 * ## Where this sits
 *
 *     text ──parseProtocol──▶ canonical message ──interpretTurn──▶ TurnInterpretation
 *                  │                                                     │
 *          (shape, validated)                              (what to do about it)
 *
 * `parseProtocol` answers "is this a well-formed PairPilot message, and of which
 * type?" That is a question about syntax. This module answers the domain
 * question: does the answer become a proposal to review, a reply to read, a
 * question to answer, or a failure to report?
 *
 * ## Why the distinction matters
 *
 * The 0.1.x codebase conflated the two. Every turn asked for a proposal, every
 * reply that was not a proposal became an error, and the developer was told to
 * "rephrase the task to ask for a specific file" after typing "Hi". Splitting the
 * two questions is what makes a greeting a greeting and a build request a build
 * request, without either one being a special case bolted onto the other.
 *
 * ## Untrusted content
 *
 * Everything here is model output. `renderMessage` produces plain text with no
 * markup and no links, because the transcript is rendered in a Webview: an
 * answer containing `[click](javascript:…)` must be inert, and the reliable way
 * to guarantee that is to never emit markup in the first place.
 */

import { parseProtocol, type ProtocolParseFailure } from '../protocol/parse';
import { PAIRPILOT_PROTOCOL_VERSION } from '../protocol/types';
import type {
  AdaptationKind,
  ClarificationRequestMessage,
  CodeProposalMessage,
  EngineeringAdviceMessage,
  ProtocolMessage,
} from '../protocol/types';

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

/** A reply that should be reviewed, approved and written. */
export interface ProposalInterpretation {
  kind: 'proposal';
  message: CodeProposalMessage;
  raw: string;
  adaptation: AdaptationKind;
  notes: string[];
}

/** A reply to read: conversation, analysis, a plan, a review, a status. */
export interface NarrativeInterpretation {
  kind: 'narrative';
  message: ProtocolMessage;
  raw: string;
  adaptation: AdaptationKind;
  notes: string[];
}

/** A reply that recommends the next engineering step. */
export interface AdviceInterpretation {
  kind: 'advice';
  message: EngineeringAdviceMessage;
  raw: string;
  adaptation: AdaptationKind;
  notes: string[];
}

/** A reply that asks the developer a question before continuing. */
export interface QuestionInterpretation {
  kind: 'question';
  message: ClarificationRequestMessage;
  raw: string;
  adaptation: AdaptationKind;
  notes: string[];
}

/** A reply that could not be read at all. */
export interface FailureInterpretation {
  kind: 'failure';
  /**
   * The parse failure itself — one-line reason plus per-field issues and a
   * truncated, redactable raw reply.
   *
   * Handed over whole rather than flattened into strings so that whoever reports
   * it can render it once. An earlier version rendered it here *and* again at the
   * point of display, and every failure arrived with its bullet list duplicated.
   */
  failure: ProtocolParseFailure;
  /** True when a retry has a realistic chance: valid JSON, wrong shape. */
  retryable: boolean;
}

export type TurnInterpretation =
  | ProposalInterpretation
  | NarrativeInterpretation
  | AdviceInterpretation
  | QuestionInterpretation
  | FailureInterpretation;

/* -------------------------------------------------------------------------- */
/* Interpretation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Decide what a reply means.
 *
 * @param text The assistant's reply, exactly as streamed.
 */
export function interpretTurn(text: string): TurnInterpretation {
  const outcome = parseProtocol(text);

  if (!outcome.ok) {
    // A reply with no JSON in it at all is the model's answer in its own words.
    // Treating that as a schema failure is precisely how "Hi" produced "PairPilot
    // did not write anything. Try rephrasing the task to ask for a specific
    // file." The developer reads the answer instead; the caller raises a notice
    // that nothing was written, so the turn is never mistaken for a success.
    if (outcome.kind === 'no_json') {
      const prose = outcome.raw.trim();
      if (prose.length > 0) {
        return {
          kind: 'narrative',
          message: {
            protocol_version: PAIRPILOT_PROTOCOL_VERSION,
            type: 'chat_response',
            message: prose,
          },
          raw: outcome.raw,
          adaptation: 'prose',
          notes: ['The reply was plain text rather than a PairPilot message; it is shown as an answer.'],
        };
      }
    }
    return toFailure(outcome);
  }

  const { message, raw, adaptation, notes } = outcome;

  switch (message.type) {
    case 'code_proposal':
      return { kind: 'proposal', message, raw, adaptation, notes };
    case 'engineering_advice':
      return { kind: 'advice', message, raw, adaptation, notes };
    case 'clarification_request':
      return { kind: 'question', message, raw, adaptation, notes };
    default:
      // chat_response, project_analysis, project_plan, architecture_discussion,
      // code_review, task_update and error are all "something to read".
      return { kind: 'narrative', message, raw, adaptation, notes };
  }
}

/**
 * Should a failure be retried?
 *
 * Only when the reply was *valid JSON of the wrong shape*. Prose is not a
 * schema failure — the model chose to answer in words, and re-asking is as
 * likely to produce prose again while costing another request. An empty reply or
 * unparseable text is likewise not something a schema correction fixes.
 */
function toFailure(outcome: ProtocolParseFailure): FailureInterpretation {
  return {
    kind: 'failure',
    failure: outcome,
    retryable: outcome.kind === 'schema' && outcome.issues.length > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Render a canonical message as plain text for the transcript.
 *
 * Plain text only — no markdown, no markup, no links. The transcript is shown in
 * a Webview, and the cheapest way to make model output inert there is for it
 * never to contain anything but sentences.
 */
export function renderMessage(message: ProtocolMessage): string {
  switch (message.type) {
    case 'chat_response':
      return message.message;

    case 'project_analysis': {
      const lines = [message.message, ''];
      const section = (title: string, values: string[]): void => {
        if (values.length === 0) {
          return;
        }
        lines.push(`${title}:`);
        for (const value of values) {
          lines.push(`  • ${value}`);
        }
        lines.push('');
      };
      section('Stack', message.analysis.stack);
      section('Structure', message.analysis.structure);
      section('Conventions', message.analysis.conventions);
      section('Gaps', message.analysis.gaps);
      return lines.join('\n').trimEnd();
    }

    case 'project_plan': {
      const lines = [message.message, ''];
      message.plan.phases.forEach((phase, index) => {
        lines.push(`Phase ${index + 1}: ${phase.name}`);
        if (phase.goal) {
          lines.push(`  Goal: ${phase.goal}`);
        }
        for (const task of phase.tasks) {
          lines.push(`  • ${task}`);
        }
        lines.push('');
      });
      if (message.plan.questions && message.plan.questions.length > 0) {
        lines.push('Open questions:');
        for (const question of message.plan.questions) {
          lines.push(`  • ${question}`);
        }
        lines.push('');
      }
      if (message.plan.risks && message.plan.risks.length > 0) {
        lines.push('Risks:');
        for (const risk of message.plan.risks) {
          lines.push(`  • ${risk}`);
        }
        lines.push('');
      }
      return lines.join('\n').trimEnd();
    }

    case 'architecture_discussion': {
      const lines = [message.message, ''];
      const section = (title: string, values: string[] | undefined): void => {
        if (!values || values.length === 0) {
          return;
        }
        lines.push(`${title}:`);
        for (const value of values) {
          lines.push(`  • ${value}`);
        }
        lines.push('');
      };
      section('Understood requirements', message.requirements);
      if (message.architecture?.components && message.architecture.components.length > 0) {
        lines.push('Components:');
        for (const component of message.architecture.components) {
          lines.push(
            component.responsibility
              ? `  • ${component.name} — ${component.responsibility}`
              : `  • ${component.name}`
          );
        }
        lines.push('');
      }
      section('Dependencies', message.architecture?.dependencies);
      section('Alternatives considered', message.architecture?.alternatives);
      section('Open questions', message.questions);
      if (message.nextStep) {
        lines.push(`Next: ${message.nextStep}`);
      }
      return lines.join('\n').trimEnd();
    }

    case 'code_review': {
      const lines = [message.message, '', `Verdict: ${message.review.verdict}`];
      if (message.review.findings.length > 0) {
        lines.push('', 'Findings:');
        for (const finding of message.review.findings) {
          const where = finding.file ? ` (${finding.file})` : '';
          lines.push(`  [${finding.severity}] ${finding.title}${where}`);
          if (finding.detail) {
            lines.push(`    ${finding.detail}`);
          }
        }
      }
      const section = (title: string, values: string[] | undefined): void => {
        if (!values || values.length === 0) {
          return;
        }
        lines.push('', `${title}:`);
        for (const value of values) {
          lines.push(`  • ${value}`);
        }
      };
      section('Security', message.review.security);
      section('Performance', message.review.performance);
      section('Tests', message.review.tests);
      return lines.join('\n');
    }

    case 'code_proposal': {
      const summary = message.summary;
      const scope = summary
        ? ` ${summary.files_to_create} to create, ${summary.files_to_update} to update.`
        : '';
      const lines = [`${message.message}${scope}`, ''];
      for (const change of message.changes) {
        lines.push(`  • ${change.operation} ${change.file} — ${change.description}`);
      }
      return lines.join('\n');
    }

    case 'engineering_advice':
      return `${message.advice.title}\n\n${message.advice.reason}`;

    case 'clarification_request': {
      const lines = [message.clarification.question];
      if (message.clarification.options && message.clarification.options.length > 0) {
        lines.push('');
        for (const option of message.clarification.options) {
          lines.push(`  • ${option}`);
        }
      }
      return lines.join('\n');
    }

    case 'task_update':
      return `${message.task.title}: ${message.task.status}${message.message ? `\n\n${message.message}` : ''}`;

    case 'error':
      return message.error.detail
        ? `${message.message}\n\n${message.error.detail}`
        : message.message;

    default: {
      const exhaustive: never = message;
      void exhaustive;
      return '';
    }
  }
}
