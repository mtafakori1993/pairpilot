/**
 * Workflow modes, intention classification, and the policy that separates them.
 *
 * ## The bug this module exists to prevent
 *
 * A developer asked:
 *
 *     "I want to build a simple PHP and SQLite user management system. First
 *      analyze the requirements and discuss the architecture with me.
 *      Do not write any code yet."
 *
 * …and PairPilot answered with a code proposal. Nothing in the pipeline had a
 * place to put "we are still deciding". There were two turn kinds — conversational
 * and engineering — and every engineering turn asked for a `code_proposal`.
 * Planning is engineering work that is *not* code, so it fell into the only
 * engineering bucket there was, and the model did the reasonable thing: it
 * produced the artifact it had been asked for. When it answered with a bare
 * change set and no prose, the adapter had to invent a summary, and the developer
 * saw "The AI proposed a change without describing it."
 *
 * ## The three questions this module answers
 *
 *  1. **What does the developer want right now?** — `classifyIntention`. Not
 *     keyword matching: an explicit instruction ("do not write code yet") wins
 *     outright, and past that the decision is read from the instruction, the
 *     recent conversation and the mode the session is already in.
 *  2. **Which mode should the session be in?** — `nextMode`. A pure function of
 *     the previous mode and the intent, separately testable, with the sticky
 *     rule that only an explicit implementation instruction crosses into CODING.
 *  3. **May a code proposal be applied in this mode?** — `policyFor`. Derived
 *     from the mode by construction, so no call site has to remember.
 *
 * ## Why the mode is not purely a function of the intent
 *
 * Because a mode is a *promise to the developer*, and promises outlive one
 * message. Someone whose requirements are settled says "yes, that's right",
 * which on its own reads as conversation; the mode has to remember that they
 * were in DISCOVERY and move them forward. Sticky modes are what let the
 * developer accept an architecture by agreeing with it, instead of having to
 * re-state the whole instruction in the shape a classifier would recognise.
 *
 * ## No `vscode` import
 *
 * Like the rest of the protocol layer, this is pure domain code so it can be
 * tested in plain Node.
 */

import type { ProtocolMessageType } from './types';

/* -------------------------------------------------------------------------- */
/* Modes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where the session is in the journey from idea to code.
 *
 * Ordered: a session moves forward through them and never silently jumps.
 */
export const WORKFLOW_MODES = ['discovery', 'architecture', 'implementation', 'coding'] as const;

export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

export interface WorkflowModeMeta {
  readonly id: WorkflowMode;
  readonly label: string;
  /** One line the developer sees, so the current mode is never a mystery. */
  readonly summary: string;
}

export const WORKFLOW_MODE_META: Readonly<Record<WorkflowMode, WorkflowModeMeta>> = {
  discovery: {
    id: 'discovery',
    label: 'Discovery',
    summary: 'Understanding what you want to build. Nothing is written.',
  },
  architecture: {
    id: 'architecture',
    label: 'Architecture',
    summary: 'Designing the shape of the system. Nothing is written.',
  },
  implementation: {
    id: 'implementation',
    label: 'Implementation planning',
    summary: 'Turning the agreed design into ordered work. Nothing is written yet.',
  },
  coding: {
    id: 'coding',
    label: 'Coding',
    summary: 'Building approved work. Every file is reviewed before it is written.',
  },
};

/* -------------------------------------------------------------------------- */
/* Intentions                                                                 */
/* -------------------------------------------------------------------------- */

/** What the developer's turn is asking for. */
export const TURN_INTENTIONS = [
  'general_chat',
  'discovery',
  'requirements_analysis',
  'architecture_discussion',
  'architecture_approval',
  'implementation_planning',
  'code_generation',
  'code_modification',
  'code_review',
] as const;

export type TurnIntention = (typeof TURN_INTENTIONS)[number];

/**
 * Phrases in which the developer states, in their own words, that no code is to
 * be written yet.
 *
 * Three families, because the same instruction arrives three ways: as a
 * prohibition ("do not write code"), as a demand for discussion ("first discuss
 * the architecture"), and as a sequencing rule ("let's agree on the design
 * first"). English and Persian are both covered — the extension is used in RTL
 * sessions, and a classifier that only understood English would route a Persian
 * planning request straight into a code proposal.
 *
 * No `\b` anywhere near the non-Latin patterns: JavaScript defines `\b` over
 * `[A-Za-z0-9_]`, so it never fires around Persian letters.
 */
const NO_CODE_YET_PATTERNS: readonly RegExp[] = [
  /do\s*n['’]?t\s+(?:you\s+)?(?:write|generate|produce|create|implement|add|output)\b/i,
  /\bno\s+(?:code|implementation|source)\b/i,
  /\bwithout\s+(?:any\s+)?(?:code|writing|implementation|creating)\b/i,
  /\bnot\s+(?:write|writing|generate|generating|implement|implementing|create|creating)\b/i,
  /\bhold\s+off\b/i,
  /\b(?:code|implementation)\s+later\b/i,
  /(?:فعلا|الان|هنوز)[^.!؟\n]{0,20}(?:کد|برنامه|پیاده)/,
  /(?:کد|برنامه|پیاده\s*سازی)[^.!؟\n]{0,20}(?:ننویس|نزن|نکن|نباشه|لازم نیست)/,
  /بدون\s*(?:نوشتن\s*)?کد/,
];

/** Phrases that ask for discussion rather than delivery. */
const DISCUSSION_PATTERNS: readonly RegExp[] = [
  /\b(discuss|discussion|talk (?:it|this) through|walk me through|brainstorm|explore|think through|reason about)\b/i,
  /\b(let'?s\s+(?:discuss|talk|agree|decide|review|think))\b/i,
  /\b(before (?:we|you) (?:start|begin|write|code|implement))\b/i,
  /(?:بحث|گفتگو)\s*(?:کنیم|کن|بشه)?/,
];

/** Phrases that name requirements rather than design. */
const REQUIREMENTS_PATTERNS: readonly RegExp[] = [
  /\b(requirements?|user stor(?:y|ies)|use cases?|acceptance criteria|scope|constraints?|features?)\b/i,
  /\b(analyse|analyze|analysis)\b/i,
  /(?:نیازمندی|الزامات|تحلیل|سناریو|ویژگی|محدودیت)/,
];

/** Phrases that name the shape of the system. */
const ARCHITECTURE_PATTERNS: readonly RegExp[] = [
  /\b(architecture|architectural|design|structure|approach|trade[- ]?offs?|alternatives?|components?|layers?)\b/i,
  /(?:معماری|طراحی|ساختار|لایه)/,
];

/**
 * Phrases that put the developer's approval on the table.
 *
 * Deliberately does *not* include "go ahead", "proceed" or "do it": those are
 * authorisations to act, not agreement with a design, and they arrive in
 * sentences like "go ahead and implement the first step" where reading them as
 * design approval would strand the developer in planning after they asked for
 * code. They live in `CODING_AUTHORISATION_PATTERNS` instead.
 */
const APPROVAL_PATTERNS: readonly RegExp[] = [
  /^(?:yes|yep|yeah|yup|ok|okay|k|sure|agreed|agree|approved?|approve|sounds good|looks good|lgtm|perfect|great|fine|correct|exactly|that works)\b/i,
  /^(?:بله|آره|درسته|موافقم|تایید|تأیید|اوکی|باشه|خوبه)/,
  /\b(?:i\s+)?(?:approve|accept|agree with|sign off on)\b[^.!?\n]{0,40}\b(?:architecture|design|plan|approach|structure)\b/i,
  /\b(?:architecture|design|plan|approach)\b[^.!?\n]{0,40}\b(?:is (?:fine|good|approved|ok)|works for me|looks good|approved)\b/i,
  /(?:معماری|طراحی|نقشه)[^.!؟\n]{0,30}(?:تایید|تأیید|خوبه|مناسبه|قبول)/,
];

/**
 * An invitation to build, which is an authorisation only once the design exists.
 *
 * "Let's build it" in the middle of establishing requirements is another way of
 * saying what the developer wants; the same words after the design has been
 * agreed are a decision to start. The sentence cannot tell the two apart — the
 * session's mode can, and does, in `classifyIntention`.
 */
const BUILD_INVITATION_PATTERNS: readonly RegExp[] = [
  /\b(?:let'?s|let us|we should|time to)\s+(?:now\s+)?(?:build|create|make|write|implement|start)\b/i,
  /(?:بریم\s*(?:بسازیم|بنویسیم|پیاده))/,
];

/**
 * Phrases that ask for an ordered body of work rather than a conversation.
 *
 * Narrower than the old engineering signal list on purpose: that one fired on
 * the word "database" or "class", which is how a discussion about a database
 * schema became a request to write one.
 */
const PLANNING_WORK_PATTERNS: readonly RegExp[] = [
  /\b(task breakdown|break (?:it|this|the work) down|implementation plan|roadmap|milestones?|work plan|sprint plan|sequenc(?:e|ing) (?:the )?(?:work|tasks|implementation))\b/i,
  /\b(?:what|which) (?:order|sequence) (?:should|do)\b/i,
  /\b(?:plan|outline) the (?:implementation|work|tasks|steps)\b/i,
  /(?:نقشه\s*راه|تقسیم\s*کار|ترتیب\s*(?:کار|پیاده)|برنامه\s*اجرا)/,
];

/**
 * Unambiguous instructions to write code.
 *
 * These name the act ("write", "implement", "build") as an imperative. They are
 * the only family that can authorise implementation on its own, because they are
 * the only family in which the developer is doing something other than describing
 * what they would like to exist.
 */
const CODING_AUTHORISATION_PATTERNS: readonly RegExp[] = [
  /\b(?:now|please|go ahead and|let'?s|ok(?:ay)?,?)\s*,?\s+(?:write|implement|build|create|generate|code)\b/i,
  /\bgo ahead\b/i,
  /\bstart (?:coding|implementing|building)\b/i,
  /\bimplement (?:it|this|that|the plan|everything|all)\b/i,
  /\bwrite the (?:code|files?|implementation)\b/i,
  // The Persian imperatives need a *letter* lookaround rather than `\b`, for the
  // reason given at the top of the conversational patterns in `classify.ts`:
  // JavaScript's `\b` is defined over ASCII and never fires around Persian
  // letters. Without the lookarounds, "میخوام ... بسازم" — "I want to build…",
  // a statement of intent — contained the substring "بساز" and was read as an
  // instruction to build.
  /(?<![؀-ۿ])(?:بنویس|بساز|ایجاد\s*کن|پیاده\s*سازی\s*کن|اضافه\s*کن)(?![؀-ۿ])/,
  /(?<![؀-ۿ])شروع\s*کن\s*به\s*(?:نوشتن|ساختن)/,
  /(?:بریم\s*(?:سراغ|برای)\s*(?:کد|پیاده))/,
];

/**
 * Descriptions of what the developer wants to exist, without an instruction to
 * create it.
 *
 * "I want to build a user management system" sits here, and it is the single
 * most common opening line of a planning conversation. Treating it as an
 * instruction to write files is the bug this module exists to fix, so it moves
 * the session no further than discovery.
 */
const WISH_PATTERNS: readonly RegExp[] = [
  /\b(?:i|we)\s+(?:want|need|would like|'?d like)\s+to\s+(?:build|create|make|write|implement|have|add)\b/i,
  /\b(?:i'?m|we'?re)\s+(?:building|planning|thinking about|considering)\b/i,
  /(?:می\s*خوام|میخوام|قصد\s*دارم|باید)[^.!؟\n]{0,30}(?:بسازم|بسازیم|پیاده|بنویسم|داشته\s*باشم|اضافه\s*کنم)/,
  /(?:میخوایم|می\s*خوایم)[^.!؟\n]{0,30}(?:بسازیم|پیاده|بنویسیم)/,
];

/**
 * Phrases that put the *discussion* first, whatever else the sentence asks for.
 *
 * "Refactor this module, but first discuss the approach" contains a modification
 * verb and a noun the modification patterns recognise, so a classifier that only
 * asks "is there a modification here?" answers yes and starts writing. The
 * deferral is the operative part of the sentence: the developer has sequenced
 * the work themselves, and the sequence is the instruction.
 */
const DEFERRAL_PATTERNS: readonly RegExp[] = [
  /\b(?:but\s+)?first\s+(?:let'?s\s+)?(?:we\s+)?(?:discuss|talk|agree|decide|review|design|plan|analyse|analyze|understand|clarify|settle)\b/i,
  /\b(?:let'?s|let us)\s+(?:first\s+)?(?:discuss|talk|agree|decide|settle)\b/i,
  /\bbefore\s+(?:we\s+|you\s+)?(?:write|start|begin|implement|code|touch|change)\b/i,
  /\bfor now\s+(?:just\s+|only\s+)?(?:design|plan|discuss|analyse|analyze|describe|outline)\b/i,
  /\b(?:just|only)\s+(?:design|plan|discuss|analyse|analyze|describe|outline)\b/i,
  /(?:اول|قبل\s*از\s*هر\s*چیز)\s*(?:بحث|گفتگو|بررسی|طراحی)\s*(?:کنیم|کن)/,
  /(?:فعلا|فقط)\s*(?:طراحی|بحث|بررسی)/,
];

/**
 *
 * "Create a PHP User class" is an instruction, not a description of a wish, and
 * the difference is grammatical: the developer addressed us and named the act.
 * It is checked *after* every planning signal, so "create an implementation
 * plan" and "let's discuss the architecture" are claimed by planning first — but
 * before the noun-matching families below, because naming a component or a
 * requirement must not demote a direct instruction into a conversation.
 */
const IMPERATIVE_PATTERNS: readonly RegExp[] = [
  /^(?:please\s+|now\s+|can you\s+|could you\s+|i(?:'?d| would) like you to\s+|i want you to\s+)?(?:write|implement|build|create|generate|add|make|produce|scaffold|refactor|rewrite|update|change|fix|delete|remove)\b/i,
  /^(?:لطفا\s*|حالا\s*)?(?:بنویس|بساز|ایجاد\s*کن|پیاده\s*سازی\s*کن|اضافه\s*کن|اصلاح\s*کن|تغییر\s*بده)/,
];

/**
 * Direct requests to change existing code.
 *
 * These bypass the mode altogether: someone who reports a bug in a file they can
 * name is not in the middle of a design conversation, whatever the session was
 * doing a moment ago. Refusing them would be the wrong kind of careful.
 */
const MODIFICATION_PATTERNS: readonly RegExp[] = [
  /\b(?:fix|debug|repair|patch|correct|refactor|rename|rewrite|update|change|modify|edit|optimi[sz]e|improve)\b/i,
  /\bthere(?:'s| is) a (?:bug|problem|mistake|typo|error)\b/i,
  /\bthis (?:is )?(?:broken|wrong|fails|failing|throws)\b/i,
  /(?:باگ|اشکال|خطا|ارور)[^.!؟\n]{0,30}(?:داره|دارد|هست|میده)/,
  /(?:این|اون)\s*(?:فایل|کد|تابع|کلاس)[^.!؟\n]{0,20}(?:رو\s*)?(?:درست|اصلاح|تغییر)\s*کن/,
];

/** A greeting, thanks, or small talk and nothing else. */
const SMALL_TALK_PATTERNS: readonly RegExp[] = [
  /^(hi|hey|hello|yo|hiya|howdy|good (morning|afternoon|evening)|salam|dorood|سلام|درود)(?![a-zA-Z])[\s!.?]*$/i,
  /^(thanks|thank you|thx|ty|cheers|مرسی|ممنون|ممنونم|سپاس|سپاسگزارم)(?![a-zA-Z])[\s!.?]*$/i,
  /^(bye|goodbye|good night|see you|خداحافظ)(?![a-zA-Z])[\s!.?]*$/i,
  /^(ok|okay|k|got it|cool|nice|great|perfect|باشه|اوکی|خوب)(?![a-zA-Z])[\s!.?]*$/i,
  /^(yes|no|yep|nope|sure|بله|نه|آره)(?![a-zA-Z])[\s!.?]*$/i,
];

/** Above this length a message is never small talk, whatever it opens with. */
const SMALL_TALK_MAX_CHARS = 80;

const REVIEW_PATTERNS: readonly RegExp[] = [
  /\b(review|critique|audit|inspect|check) (?:this|the|my|our)?\s*(?:code|file|function|class|module|implementation|changes?)\b/i,
  /\bwhat do you think of\b/i,
  /(?:بازبینی|نقد|بررسی)\s*کن/,
];

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

/** Everything the classifier is allowed to look at. */
export interface IntentionInput {
  /** The developer's instruction, verbatim. */
  task: string;
  /** The mode the session was already in before this turn. */
  previousMode: WorkflowMode;
  /**
   * Recent turns, oldest first — the developer's and the assistant's.
   *
   * Used for one thing only: noticing that the model asked a question and the
   * developer's short reply is the answer to it. That is the difference between
   * "yes" as small talk and "yes" as the second half of a requirements
   * conversation.
   */
  recentTurns?: readonly { role: 'user' | 'assistant' | 'system'; text: string }[];
}

/** A classification, with the reason so it can be explained rather than guessed at. */
export interface IntentionResult {
  intention: TurnIntention;
  /** Why, in one line. Shown in diagnostics; never a mystery. */
  reason: string;
  /** True when the developer stated an explicit constraint we must obey. */
  explicit: boolean;
}

/**
 * Classify a developer's instruction.
 *
 * The order of the checks is the whole design:
 *
 *  1. An explicit "no code yet" instruction outranks everything. It is the
 *     developer telling us the rule directly, and a classifier that weighs it
 *     against other signals can lose an argument it should never have entered.
 *     Within that branch, which *kind* of planning is meant is still read from
 *     the words: this is what sends "analyze the requirements and discuss the
 *     architecture" to DISCOVERY rather than to the design table, because you do
 *     not design a system before you know what it has to do.
 *  2. A named bug or a direct request to change code is honoured from any mode.
 *     Careful is not the same as obstructive.
 *  3. Small talk is small talk.
 *  4. Approval, then discussion, then requirements, then a breakdown of work.
 *  5. Only then authorisation to code, and only from words that ask for the act.
 *  6. Otherwise the session's own mode is the tie-breaker.
 */
export function classifyIntention(input: IntentionInput): IntentionResult {
  const text = (input.task ?? '').trim();

  if (text.length === 0) {
    return { intention: 'general_chat', reason: 'The instruction was empty.', explicit: false };
  }

  // 0. The developer sequenced the work themselves. "Refactor this, but first
  //    discuss the approach" is a modification verb sitting next to a deferral,
  //    and the deferral is the operative half: they have told us to wait. This
  //    runs before the modification family precisely so that the verb cannot win
  //    the argument on its own.
  if (matchesAny(text, DEFERRAL_PATTERNS)) {
    const kind = planningKind(text);
    return {
      intention: kind.intention,
      reason: `The developer deferred the work (${kind.reason}), so this turn is the discussion they asked for first.`,
      explicit: true,
    };
  }

  // 1. An explicit "no code yet" constraint, checked before anything else.
  //    It is the developer stating the rule directly, and a classifier that
  //    weighed it against other signals could lose an argument it should never
  //    have entered. Which *kind* of planning is meant is still read from the
  //    words — requirements before architecture — because you do not design a
  //    system before you know what it has to do.
  if (matchesAny(text, NO_CODE_YET_PATTERNS)) {
    const kind = planningKind(text);
    return {
      intention: kind.intention,
      reason: `The developer explicitly asked for no code yet (${kind.reason}), so this turn is planning whatever else it mentions.`,
      explicit: true,
    };
  }

  // 2. A direct request to change code, from any mode.
  if (matchesAny(text, MODIFICATION_PATTERNS)) {
    return {
      intention: 'code_modification',
      reason: 'The developer named something concrete to change.',
      explicit: true,
    };
  }

  // 3. Small talk.
  if (text.length <= SMALL_TALK_MAX_CHARS && matchesAny(text, SMALL_TALK_PATTERNS)) {
    return {
      intention: 'general_chat',
      reason: 'This is a greeting or acknowledgement.',
      explicit: false,
    };
  }

  // 4. Planning families, in precedence order. Each of these claims the turn
  //    before any noun-matching check below can, so "create an implementation
  //    plan" is a plan and never a file.
  const planning = matchesAny(text, PLANNING_WORK_PATTERNS);
  if (planning) {
    return {
      intention: 'implementation_planning',
      reason: 'The developer asked for the work to be broken down or ordered.',
      explicit: true,
    };
  }

  if (matchesAny(text, REVIEW_PATTERNS)) {
    return {
      intention: 'code_review',
      reason: 'The developer asked for an assessment of existing code.',
      explicit: true,
    };
  }

  if (matchesAny(text, DISCUSSION_PATTERNS)) {
    const kind = planningKind(text);
    return {
      intention: kind.intention,
      reason: 'The developer asked to talk the design through rather than to receive code.',
      explicit: true,
    };
  }

  // An invitation to build counts as an authorisation once the design exists,
  // and as a statement of intent before that. Position, not wording, decides.
  if (matchesAny(text, BUILD_INVITATION_PATTERNS)) {
    return input.previousMode === 'implementation' || input.previousMode === 'coding'
      ? {
          intention: 'code_generation',
          reason: 'The design is agreed and the developer asked to start building.',
          explicit: true,
        }
      : {
          intention: 'requirements_analysis',
          reason:
            'The developer said what they want to build. The design has not been agreed yet, so nothing is authorised.',
          explicit: false,
        };
  }

  if (matchesAny(text, APPROVAL_PATTERNS)) {
    // Approval is only read as design approval while the session is at the
    // design table. In Coding it is an acknowledgement of whatever was just
    // said, which needs no transition — reading it as "go" would make every
    // "ok" a new turn's worth of writes.
    const inDesign = input.previousMode !== 'coding';
    if (inDesign || askedAQuestion(input.recentTurns)) {
      return {
        intention: 'architecture_approval',
        reason: inDesign
          ? `The developer agreed with the design while the session was in ${input.previousMode}.`
          : 'The developer answered a question the AI asked.',
        explicit: true,
      };
    }
  }

  // 5. An instruction addressed to us, with the act named. This is the edge into
  //    CODING, and it is checked before the noun families so that "create a User
  //    class" is work while a sentence that merely mentions a class is not.
  if (matchesAny(text, MODIFICATION_PATTERNS) || matchesAny(text, IMPERATIVE_PATTERNS)) {
    return {
      intention: 'code_generation',
      reason: 'The developer instructed us to make a change.',
      explicit: true,
    };
  }

  if (matchesAny(text, CODING_AUTHORISATION_PATTERNS)) {
    return {
      intention: 'code_generation',
      reason: 'The developer asked for the code to be written.',
      explicit: true,
    };
  }

  // 6. Describing, not instructing. Naming the design is a design conversation;
  //    naming requirements is a requirements conversation; and a sentence about
  //    what the developer would like to exist settles the requirements and no
  //    more — it is not an instruction to create it.
  if (matchesAny(text, ARCHITECTURE_PATTERNS)) {
    return {
      intention: 'architecture_discussion',
      reason: 'The developer is talking about the shape of the system.',
      explicit: false,
    };
  }

  if (matchesAny(text, REQUIREMENTS_PATTERNS) || matchesAny(text, WISH_PATTERNS)) {
    return {
      intention: 'requirements_analysis',
      reason:
        'The developer is describing what the system has to do. Nobody has asked for code yet.',
      explicit: false,
    };
  }

  // 7. Nothing recognised. The session's own mode decides, so a settled
  //    conversation is not reset by an ambiguous sentence.
  switch (input.previousMode) {
    case 'discovery':
      return {
        intention: 'discovery',
        reason: 'Still gathering requirements; nothing has been settled.',
        explicit: false,
      };
    case 'architecture':
      return {
        intention: 'architecture_discussion',
        reason: 'The session is working through the design.',
        explicit: false,
      };
    case 'implementation':
      return {
        intention: 'implementation_planning',
        reason: 'The design is agreed and the work is being ordered.',
        explicit: false,
      };
    case 'coding':
      return {
        intention: 'code_modification',
        reason: 'The session is implementing, so a bare instruction is work to do.',
        explicit: false,
      };
  }
}

/**
 * Which kind of planning a message is asking for.
 *
 * Shared by the explicit-constraint branch and the discussion branch. The rule is
 * one of precedence: requirements before architecture before the default, because
 * a sentence that mentions both requirements and design is still asking about
 * requirements first.
 */
function planningKind(text: string): { intention: TurnIntention; reason: string } {
  if (matchesAny(text, REQUIREMENTS_PATTERNS)) {
    return { intention: 'requirements_analysis', reason: 'the requirements were named' };
  }
  if (matchesAny(text, ARCHITECTURE_PATTERNS)) {
    return { intention: 'architecture_discussion', reason: 'the architecture was named' };
  }
  if (matchesAny(text, DISCUSSION_PATTERNS)) {
    // "Let us discuss it", with no noun at all. Once requirements are on the
    // table, the thing there is to discuss is the shape of the system — so a
    // bare invitation to talk is design talk. Requirements win above because a
    // sentence that names both is asking about requirements first.
    return { intention: 'architecture_discussion', reason: 'a discussion was asked for' };
  }
  return { intention: 'requirements_analysis', reason: 'no particular planning stage was named' };
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Did the assistant's most recent turn ask something, so a short reply answers it? */
function askedAQuestion(
  turns: readonly { role: 'user' | 'assistant' | 'system'; text: string }[] | undefined
): boolean {
  if (!turns || turns.length === 0) {
    return false;
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!turn || turn.role !== 'assistant') {
      continue;
    }
    return turn.text.trimEnd().endsWith('?');
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Mode                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Which mode the session should be in for this turn.
 *
 * Pure, and pure on purpose: it has the same inputs and one output, so
 * "architecture approval did not authorise code" is a statement a test can make
 * about a function rather than an observation about an integration.
 */
export function nextMode(previous: WorkflowMode, intention: TurnIntention): WorkflowMode {
  switch (intention) {
    case 'general_chat':
      // A greeting leaves the session exactly where it was. Chatting about the
      // weather must not abandon a design conversation.
      return previous;
    case 'discovery':
    case 'requirements_analysis':
      // Asking for requirements is the definition of discovery, whatever the
      // session was doing before. A developer who goes back to requirements
      // gets to go back to requirements.
      return 'discovery';
    case 'architecture_discussion':
      return 'architecture';
    case 'architecture_approval':
      // Agreeing with a design is not authorising the code. It settles the
      // design and hands the developer the roadmap — the next step they asked
      // for — and stops there. The edge into CODING belongs to an instruction
      // that names the act of writing, which is a different intention.
      return 'implementation';
    case 'implementation_planning':
      return 'implementation';
    case 'code_generation':
    case 'code_modification':
    case 'code_review':
      // The only edge into CODING, and only from an intention that named work.
      // approval of a design is a different intention and lands in
      // `architecture` above, which is what stops "yes, that design is right"
      // from being read as "go and write it".
      return 'coding';
  }
}

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

export interface WorkflowPolicy {
  readonly mode: WorkflowMode;
  /** May a `code_proposal` be staged for approval in this mode? */
  readonly allowsProposals: boolean;
  /** May a proposal, once approved, be written to disk? */
  readonly allowsWrites: boolean;
  /** Message types a reply may use this turn. Anything else is refused. */
  readonly allowedTypes: readonly ProtocolMessageType[];
  /**
   * What to tell the model about this mode.
   *
   * Goes into the per-turn prompt. It states the mode's rules positively — what
   * this turn *is* — because a prompt that only says "do not write code" invites
   * the model to find a legal-looking way to write code anyway.
   *
   * @param intent What the turn's wording suggests, so a greeting in Discovery is
   *   answered as a greeting rather than as a request to summarise requirements.
   */
  readonly hint: (intent?: 'conversational' | 'engineering') => string;
}

/** Every type except the proposal: the set a planning turn may answer with. */
const PLANNING_TYPES: readonly ProtocolMessageType[] = [
  'chat_response',
  'project_analysis',
  'project_plan',
  'architecture_discussion',
  'code_review',
  'engineering_advice',
  'clarification_request',
  'task_update',
  'error',
];

const CODING_TYPES: readonly ProtocolMessageType[] = ['code_proposal', ...PLANNING_TYPES];

const NO_CODE_RULE =
  'Nothing may be written this turn. Do not produce a "code_proposal", do not include file contents, and do not treat any directory layout you describe as an instruction to create it. Describe responsibilities and boundaries in prose and names only.';

/** The policy for a mode. Derived from the mode, so it cannot drift from it. */
export function policyFor(mode: WorkflowMode): WorkflowPolicy {
  switch (mode) {
    case 'discovery':
      return {
        mode,
        allowsProposals: false,
        allowsWrites: false,
        allowedTypes: PLANNING_TYPES,
        hint: (intent) =>
          [
            'The session is in DISCOVERY: understanding what the developer wants to build.',
            ...(intent === 'conversational'
              ? [
                  'This turn is small talk — a greeting or an acknowledgement. Answer it as one, in a sentence.',
                  'Do not turn it into a requirements summary, and do not ask a clarifying question: nobody has described a project yet this turn.',
                ]
              : [
                  'Summarise the requirements you have understood so far in your own words, then ask ONE clarifying question that genuinely changes the design.',
                  'Use "clarification_request" when you need an answer, or "chat_response" when you are summarising.',
                ]),
            'If the developer seems ready to build, say in your message that they can ask for the code whenever they like — they are in control of when implementation starts.',
            NO_CODE_RULE,
          ].join('\n'),
      };

    case 'architecture':
      return {
        mode,
        allowsProposals: false,
        allowsWrites: false,
        allowedTypes: PLANNING_TYPES,
        hint: (intent) =>
          [
            'The session is in ARCHITECTURE: designing the shape of the system with the developer.',
            ...(intent === 'conversational'
              ? ['This turn is small talk. Answer it briefly and stay in the design conversation.']
              : [
                  'Use "architecture_discussion". Name the components and what each one is responsible for, say which depends on which, and mention any alternative you rejected and why.',
                  'End by asking the developer to review the design. Their agreement is what moves the session on — it does not authorise code by itself.',
                ]),
            NO_CODE_RULE,
          ].join('\n'),
      };

    case 'implementation':
      return {
        mode,
        allowsProposals: false,
        allowsWrites: false,
        allowedTypes: PLANNING_TYPES,
        hint: (intent) =>
          [
            'The session is in IMPLEMENTATION PLANNING: turning the agreed design into ordered work.',
            ...(intent === 'conversational'
              ? ['This turn is small talk. Answer it briefly and stay with the plan.']
              : [
                  'Use "project_plan". List the work in the order it must happen, say which piece depends on which, and give each piece a way to tell it is finished.',
                  'This is a plan, not code. When the developer authorises implementation, the files themselves come next.',
                ]),
            NO_CODE_RULE,
          ].join('\n'),
      };

    case 'coding':
      return {
        mode,
        allowsProposals: true,
        allowsWrites: true,
        allowedTypes: CODING_TYPES,
        hint: () =>
          [
            'The session is in CODING and the developer has authorised implementation.',
            'Use "code_proposal" with every file the task needs, each carrying its complete final content.',
            'Use "chat_response" if the instruction turns out to be a question, and "clarification_request" if a genuine ambiguity blocks you.',
          ].join('\n'),
      };
  }
}

/**
 * May this message type be acted on in this mode?
 *
 * The check runs on the *validated message*, against the policy's own allow-list,
 * so a model that answers a planning turn with a `code_proposal` is refused by
 * the same rule that describes the mode — not by a second, parallel list that
 * could fall out of step with it.
 */
export function typeAllowedIn(policy: WorkflowPolicy, type: ProtocolMessageType): boolean {
  return policy.allowedTypes.includes(type);
}

/**
 * The refusal shown when a model answers a planning turn with a code proposal.
 *
 * Names what happened, what the mode allows, and how to move on — because the
 * developer did nothing wrong and needs to know that.
 */
export function refusedProposalReason(mode: WorkflowMode): string {
  const meta = WORKFLOW_MODE_META[mode];
  return [
    `The AI proposed code changes while the session was in ${meta.label}, which is a planning mode, so nothing was written.`,
    '',
    'PairPilot did not apply the proposal and did not create any files. To move on, either:',
    '  • continue the discussion and settle the design, or',
    "  • say plainly that you want the code written — for example \"go ahead and implement it\" — and the session will move to Coding.",
  ].join('\n');
}
