/**
 * Deciding what kind of answer a turn should ask for.
 *
 * ## The problem
 *
 * PairPilot 0.1.x asked for a code proposal on *every* turn, including "Hi".
 * A model that answered the greeting conversationally produced prose, the parser
 * found no JSON, and the developer was shown:
 *
 *     No JSON object was found in the response… Try rephrasing the task to ask
 *     for a specific file.
 *
 * …for saying hello. That is the same class of mistake as the rejection in
 * `adapt.ts`: the extension asked the wrong question and then reported the
 * answer as a failure.
 *
 * ## The approach
 *
 * The system prompt now lets the model choose the message type, so a greeting
 * can be answered with `chat_response` and a build request with
 * `code_proposal`. This module supplies a *hint* on top of that: when a turn is
 * confidently conversational, the prompt says so, which makes the right answer
 * near-certain without the extension ever overriding what the model decided.
 *
 * The heuristic is deliberately asymmetric. A false "engineering" on a greeting
 * costs one slightly odd prompt; a false "conversational" on a real request
 * would talk the developer out of the code they asked for. So it only fires on a
 * short message that matches a conversational pattern *and* contains nothing
 * that looks like an instruction to change code.
 */

/** What a turn is expected to produce. */
export type TurnIntent =
  /** Ordinary conversation: greeting, thanks, a question about PairPilot. */
  | 'conversational'
  /** Anything else: build, change, explain code, plan, review. */
  | 'engineering';

/**
 * Openers that are only conversational. Anchored at the start and matched
 * against the whole message, so "hi, add a login page" is *not* conversational.
 *
 * The trailing `(?![a-zA-Z])` stands where a word boundary would, and is used
 * instead of `\b` because JavaScript defines `\b` over `[A-Za-z0-9_]`: after a
 * Persian word there is no boundary at end-of-string, so every Persian greeting
 * below failed to match and was classified as an engineering request.
 */
const CONVERSATIONAL_PATTERNS: readonly RegExp[] = [
  /^(hi|hey|hello|yo|hiya|howdy|good (morning|afternoon|evening)|salam|dorood|سلام|درود)(?![a-zA-Z])[\s!.?]*$/i,
  /^(thanks|thank you|thx|ty|cheers|مرسی|ممنون|ممنونم|سپاس|سپاسگزارم)(?![a-zA-Z])[\s!.?]*$/i,
  /^(bye|goodbye|good night|see you|خداحافظ)(?![a-zA-Z])[\s!.?]*$/i,
  /^(ok|okay|k|got it|cool|nice|great|perfect|باشه|اوکی|خوب)(?![a-zA-Z])[\s!.?]*$/i,
  /^(yes|no|yep|nope|sure|بله|نه|آره)(?![a-zA-Z])[\s!.?]*$/i,
];

/**
 * Substrings that make a message an engineering request even if it opens like
 * small talk. The list is intentionally about *intent*, not technology — "add",
 * "fix", "why does", "review this" all mean work is being asked for.
 */
const ENGINEERING_SIGNALS: readonly RegExp[] = [
  // Directives.
  /\b(add|create|build|make|write|implement|generate|refactor|rename|move|extract|introduce|scaffold|bootstrap|set ?up|install|configure|migrate|optimi[sz]e|speed up|fix|debug|repair|patch|update|change|modify|edit|rewrite|delete|remove|drop|revert|test|lint|format|document|commit|deploy)\b/i,
  // Persian directives, since the extension is used in RTL sessions. No `\b`
  // here: JavaScript's word boundary is defined over ASCII, so it does not fire
  // around non-Latin letters.
  /(بساز|بسازید|ایجاد|اضافه|بنویس|پیاده|اصلاح|درست|تغییر|حذف|بررسی|تست|مستند|ریفکتور)/,
  // Questions that require reading the project.
  /\b(why|how|what|where|which|explain|describe|analyse|analyze|review|compare|inspect|find|search|check)\b/i,
  // Code-shaped tokens.
  /`[^`]+`/,
  /\.(ts|tsx|js|jsx|php|py|rb|go|rs|java|kt|cs|vue|svelte|sql|json|ya?ml|md|css|scss|html)\b/i,
  /\b[a-z0-9_]+\([^)]*\)/i, // a call or signature
  /[/\\][\w.-]+[/\\]/, // a path
  /\b(class|function|interface|method|module|component|endpoint|route|schema|query|api|database|table|test|bug|error|exception|stack ?trace)\b/i,
];

/** Above this length a message is never treated as small talk. */
const CONVERSATIONAL_MAX_CHARS = 80;

/**
 * Classify a developer's instruction.
 *
 * @param task The developer's message, verbatim.
 */
export function classifyTurnIntent(task: string): TurnIntent {
  const text = (task ?? '').trim();
  if (text.length === 0) {
    return 'conversational';
  }
  // A long message is never just a greeting, whatever it opens with.
  if (text.length > CONVERSATIONAL_MAX_CHARS) {
    return 'engineering';
  }
  // Any engineering signal at all wins: the cost of assuming work was meant is
  // one clarifying reply, while the cost of assuming small talk is refusing an
  // instruction.
  if (ENGINEERING_SIGNALS.some((pattern) => pattern.test(text))) {
    return 'engineering';
  }
  if (CONVERSATIONAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'conversational';
  }
  // Short and unlike anything recognised: ask for the general contract and let
  // the model decide what the developer wants.
  return 'engineering';
}

/**
 * The instruction appended to the prompt describing which type to answer with.
 *
 * @param intent What the turn looks like from the wording alone.
 * @param allowProposals Whether the session's mode permits a code proposal.
 *   When it does not, the list omits it entirely rather than mentioning it and
 *   forbidding it: a prompt that offers a type in one paragraph and bans it in
 *   another has given the model two rules and no way to choose between them.
 */
export function expectedTypeHint(intent: TurnIntent, allowProposals = true): string {
  if (intent === 'conversational') {
    return [
      'This turn is conversational: the developer greeted you, thanked you, or is making small talk.',
      'Answer with a "chat_response" message. Do not propose file changes unless the developer actually asks for one.',
    ].join('\n');
  }
  return [
    'Choose the message type that fits the developer\'s instruction:',
    ...(allowProposals
      ? [
          '- "code_proposal" when they ask you to create, change, or add code. Include every file the task genuinely needs in one proposal.',
        ]
      : []),
    '- "chat_response" for a question you can answer in words.',
    '- "project_analysis" when they ask what the project contains.',
    '- "project_plan" when they ask for a plan, roadmap, or ordered work.',
    '- "architecture_discussion" when they want to design or discuss the structure — including when they say not to write code yet. It carries no file paths and no file contents.',
    '- "code_review" when they ask you to review code that already exists.',
    '- "clarification_request" when you genuinely cannot proceed without an answer. Ask one question, not a list.',
    'A request to think about the design is not a request to build it.',
  ].join('\n');
}

/**
 * The instruction for a turn that *is* a code change, in a mode that allows one.
 *
 * The generic list above invites the model to weigh types; for an unambiguous
 * build instruction in Coding, weighing is the failure mode. This variant
 * names the answer outright and restates the two rules a summary-shaped reply
 * breaks: the `changes` array must exist, and each change's `content` must be
 * the complete file. A reply that describes the file instead of containing it
 * is precisely the "did not match the response contract" failure the developer
 * reported, and this is the one place it can be prevented rather than
 * corrected.
 */
export function codeProposalDemandHint(): string {
  return [
    'This turn asks for a code change, and the session is authorised to write code.',
    'Answer with a "code_proposal". This is not a choice: do not answer with "chat_response", "project_plan" or "architecture_discussion", however natural a summary feels.',
    'The "changes" array MUST be present and non-empty, and every change MUST carry "file", "operation", "description" and "content".',
    '"content" is the complete final file — every line, exactly as it should appear on disk. Never a description of the file, never a summary, never a placeholder such as "// rest of the code here".',
    'If you genuinely cannot produce the code, answer with "clarification_request" and ask the one question that blocks you — but do not answer a build instruction with a description.',
  ].join('\n');
}
