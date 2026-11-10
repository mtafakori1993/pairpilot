# Changelog

All notable changes to PairPilot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0]

Code review moved into the editor, and the provider/model screens moved out of
the sidebar. Both come from the same problem: a small Webview was being asked to
be a review surface and a settings application at once.

### Changed

- **A written file is reviewed on the file itself.** Approve, Request changes and
  Reject live on a comment thread anchored to the top of the document, with a
  native modal for the decision. The sidebar's Review tab is now a *status* view:
  which files are pending, written, under revision or failed, and a button that
  opens the editor.
- **The panel has no way to decide.** `WebviewRequest` has no approval or decision
  variant at all, so a stale, reloaded or compromised panel cannot approve code —
  the message it would have to send does not exist. The old hash-carrying decision
  messages were removed with their validator branches.
- **Provider and model configuration is native UI.** `PairPilot: Select Provider…`
  and `PairPilot: Select Model…` run QuickPick flows — provider, then the step to
  configure, then filters, then a searchable list, then confirm — instead of a
  provider manager panel. A status-bar item shows the active provider and model
  and opens the same flow. The `pairpilot.providersView` panel and its
  `Show AI Providers & Models` command are gone.
- **Roadmap-driven progression.** When the workspace has a `ROADMAP.md`, the
  coding prompt carries it, and approving a file updates that task's status and
  offers the next file. A task becomes `done` only when all its files are approved
  *and* you confirm the work was verified; an approved-but-untested task stays
  `in_progress`.

### Added

- `src/roadmap/` — a tolerant ROADMAP.md parser with dependency-aware selection, a
  `WorkspaceEdit`-based status writer, and the continuation that decides what comes
  next, all testable without an editor.
- `src/review/` — the in-editor review surface, keyed per document, with a session
  that refuses a stale decision by content hash and document fingerprint — and
  `WritePermission`, the native prompt that answers the permission gate before
  anything is written.
- `src/config/` — the native selection flow's prompt data, the picker, and the
  status-bar item.
- Prompting: generated code now carries Persian explanation comments (what and why,
  in the target language's comment syntax), and the coding turn is told to write
  exactly one file from the roadmap at a time.

### Fixed

- **A proposal stopped dead at "waiting for permission to write".** Removing the
  sidebar's approval buttons left the pre-write gate with no surface at all:
  `approveFileCreation` and `rejectFileCreation` had no caller, the panel said the
  prompt was in the editor, and `PairPilot: Review a Waiting File…` answered "no
  file is waiting" — while the workflow sat at `WAITING_FILE_APPROVAL` with no way
  to leave it. The gate is now a native prompt (`WritePermission`) raised as soon
  as the proposal arrives: Write it, Request changes, Reject, plus Write all when a
  batch is in flight. A dismissed prompt stays pending and can be raised again;
  a prompt whose proposal changed underneath it applies nothing.
- **A correction could not be requested before the first write.** Request changes
  at the permission gate had no path — the only revision route required a written
  file to roll back. `requestChangesBeforeWrite` shares the revision turn with the
  written-file path and skips the rollback, because nothing has been written yet.
- **A settled batch could discard the file the roadmap had just offered.** After
  the last file of a batch, the advisor turn and the next file's turn ended up
  ordering nested turns from one counter, so the second was rejected as stale and
  the offer was lost inside the advisor's error handler. The counter is now
  advanced before the batch settles, and the approved paths are captured before
  the change set — and with it the batch and approval history — is discarded.
- **`roadmap.md` written in place was unreadable as `in_progress`.** The status
  reader stripped every underscore rather than only wrapping emphasis, turning the
  canonical `in_progress` into `inprogress` and silently resetting started tasks
  to `todo`.
- **"make simple x.html for test agent" died on the `/changes` contract, with the
  code one level away.** Four separate defects produced the same refusal for
  replies that *did* carry complete file content:
  - The adapter's nested-payload lift was gated on the mere presence of a root
    `changes` key, so a reply pairing an empty root `changes: []` with the real
    list under `proposal` never had the payload lifted — the model's summary was
    shown, the complete file beside it was discarded, and the turn failed with
    `A code_proposal must carry a non-empty "changes" array`.
  - Parsing stopped at the first JSON object that failed validation, so a reply
    that narrated a summary-shaped object first and delivered the real proposal a
    paragraph later never found the proposal. The scan now continues, with a
    containment gate: nothing inside a rejected whole document may validate on
    its own, so a proposal refused as a set still cannot have one file salvaged
    out of it.
  - A bare change spelling its operation in `type`
    (`{"file":"x.html","type":"create","content":"…"}`) was misread as an
    envelope and refused with the backwards complaint that `"create"` is not a
    message type. A `changes` value sent as a single object is now likewise read
    as a one-change array.
  - In Coding mode an unambiguous build instruction offered the model a *menu* of
    message types. The model choosing "describe the file" is the failure: such a
    turn now demands a `code_proposal` with complete content outright.
- **A revision request had no correction loop at all.** `retryWithFeedback` — the
  path every "request changes" decision takes — made exactly one request with the
  generic type menu. The first summary-shaped reply ended the revision with the
  contract error and the developer's feedback was lost with it. The revision turn
  now demands the proposal outright and runs the same bounded correction loop as
  the primary turn: up to two corrective retries carrying the validator's own
  field-level complaint, then a failure that names the real problem.

## [0.3.1]

A follow-up to the report of:

```
The reply was valid JSON but did not match the PairPilot response contract.
/changes/0/file — The "file" field is required and was not present.
```

The developer had asked for implementation, the session was in Coding, and the
model's reply was refused for a field it had — under another name. The path is the
field a reply most easily misnames, and the diagnostic said only that `file` was
absent: it did not say which change, did not say what *had* arrived, and did not
say what a change should look like. A corrective retry with nothing to correct
comes back with a different field misnamed.

### Fixed

- **A path sent as `fileName`, `relativePath`, `file_path`, `path`, `target` or
  any of ten other spellings was refused as missing.** Adaptation already
  renamed key names, but its list of aliases stopped short of the spellings
  models actually use — and the reply was rejected as incomplete while the path
  sat one key away. The aliases now cover the unambiguous spellings, and every
  rename is recorded as an adaptation note, so a reply that adapted cleanly is no
  longer indistinguishable from one that matched the contract on the nose. What
  is *not* done is inventing a path: a change with no path under any name is
  still refused, because guessing one would put a file in front of the developer
  that nobody proposed.
- **A change list sent under `files` was recognised and then thrown away.**
  `adaptCandidate` accepted a root-level `files` array as the change list, and
  nothing renamed it to `changes`, so validation refused the reply for carrying no
  `changes`. The diagnostic blamed the model for a reply adaptation had already
  accepted. It is now renamed, and noted.
- **A change that was not an object produced four misleading complaints.** The
  element was wrapped in an object so that validation could report it — which
  made it an object, so validation reported four missing fields against a change
  that had no fields at all. It is now passed through untouched and reported for
  what it is: `Change 1 must be a JSON object but arrived as a string.`
- **A missing field said nothing about what was expected.** The reported message
  is replaced by one that names the change in the developer's own counting, quotes
  the keys that *did* arrive, and states the shape that was expected. The
  `content` and `operation` complaints gained the change index and path for the
  same reason: each of these messages is read on its own, by a model that has to
  decide what to send next.
- **The corrective retry carried the complaint but not the contract.** The retry
  prompt now restates the exact structure a `code_proposal` must have — the four
  fields every change carries, in the spelling the host parses — because a model
  asked only "what was wrong?" can fix that field and misname the next one. The
  retry budget is unchanged at two, and a retry still never re-enters the state
  machine: only the first attempt transitions.
- **The prompt now states which fields are required.** The example was correct;
  the rules below it named `file`, `operation` and `content` and left
  `description` to be inferred from the example.
- **A dangling `this.roadmapGenerated = false;` in `resetTurnState()`.** The
  field is declared nowhere in the repository — the 0.3.0 commit contained a
  reference to it, and `tsc --noEmit` fails on it with `TS2339`. Removed. The
  roadmap *prompt* and the plan-leading-to-coding transition are untouched; what
  is gone is a leftover assignment from a feature this build does not have.

### Added

- **A `content` given as an array of lines is joined** with newlines, and noted.
  The lines are the model's own, in its own order; nothing is added between them
  but a newline. This is shape rewriting, which is what adaptation is for — unlike
  inventing content, which it must never do.
- **A valid reply of another type is answered as that type.** Twenty-one tests
  pin the mapping — `chat_response`, `engineering_advice`,
  `clarification_request`, `project_analysis`, `project_plan`,
  `architecture_discussion`, `code_review`, `task_update` and `error` — because
  coercing a reply into `code_proposal` on an implementation turn is how "the
  model asked a question" becomes "the model failed the contract". A
  `chat_response` that also carries a `changes` array is still a chat response.

### Verification

- 1040 unit tests across 32 files, including the eight cases this report asked
  for: a missing `file`, a missing `type`, missing content for create and for
  update, nested proposal structures, a wrong response type, malformed JSON, a
  successful corrected retry, and no filesystem writes after a validation
  failure.
- 12 cases in a real VS Code Extension Development Host, unchanged.
- `tsc --noEmit` clean. NOTE: the 0.3.0 commit did **not** typecheck — the
  dangling `roadmapGenerated` reference was in it, and an earlier check of that
  tree reported otherwise. It is fixed here.

## [0.3.0]

This release is about the multi-file proposal, end to end. Approving seven files
now writes seven files — and revising one of them no longer throws away the other
six. Review also moved out of the panel and into the editor, where the code
actually lands.

### Fixed

- **A revision discarded the rest of the batch.** This was the reported
  "seven approved files produced nothing" failure, and the cause was not in the
  panel. Asking for changes to one file sent the turn back through the proposal
  stage, which rebuilt the batch from the model's reply — and a revision reply
  contains one file. The other six were dropped without a word, so the next
  authorization had nothing to authorize and the write path correctly reported
  that no content had been sent. A revision now **merges** into the batch
  (`BatchQueue.mergeRevision`): the revised path and any file the revision adds
  are the only entries touched, every sibling keeps its file id, hash and status,
  and the proposal version advances once for the whole merge. A revision naming a
  path that is not in the batch is refused with `StaleBatchDecisionError` rather
  than silently enlarging the proposal.
- **`update` appended instead of replaced.** The writer inserted at the end of
  the document while the original content was still in it, so the file on disk
  was the old code followed by the new. The post-write read-back comparison then
  failed and every update rolled back as a failure — an update could never
  succeed. `LiveWriter.begin` now clears the document through a real
  `WorkspaceEdit` (undoable, not a disk rewrite) so an update replaces what was
  there. Covered by an assertion on the document text itself in the Extension
  Host suite, not only on the final state.
- **A refused `WorkspaceEdit` silently dropped the chunk.** `flush()` cleared its
  buffer *before* applying the edit, so when VS Code refused one — its "has
  changed in the meantime" refusal — those characters were gone from both the
  buffer and the document, and the stream reported success while writing less
  than the proposal. The buffer is now consumed only after a successful apply,
  with bounded retries, and a document that lost the tail is repaired from the
  record of what was actually emitted.
- **A file created on disk raced its own first write.** Creating the file fires
  VS Code's watcher, which reloads the document and invalidates the pending edit,
  so the opening chunk of every `create` was refused. The writer now waits for
  the document to settle *before* installing the manual-edit guard — the order
  matters, because the reload arrives as a document change and a guard installed
  first would read it as the developer editing the file.
- **A refusal says what actually failed.** Every
  precondition is now checked before the editor is touched, so a file is never
  created empty and then left that way because the content turned out to be
  missing further down. A refusal names the file and which check failed — the
  proposal no longer contains it, its content is empty, its hash moved after
  approval, its path no longer resolves inside the workspace, or no approval
  covers it — instead of one generic message. No placeholder or empty file is
  ever created as a substitute for content that did not arrive.

### Added

- **A batch ledger, owned by the Extension Host.** Every multi-file proposal
  gets a persistent record: batch id, proposal id and version, and per file its
  id, path, operation, content hash, status (`pending` / `writing` / `completed` /
  `failed`) and note. The panel renders this record; it does not own it. A reload
  of the panel re-reads it and shows the same picture, because nothing about the
  batch lives in the Webview.
- **Decisions are bound to the proposal, not just the bytes.** A decision may
  state `proposalId`, `proposalVersion` and `fileId`, and the host checks each
  against its own record. A superseded version and a file id from a different
  proposal are both refused — "approve the file that was on screen" is now
  enforceable rather than assumed. The authorization event is never a bare
  `approved: true`: the host resolves the content to write from its own store.
- **Per-path write locks.** Two review sessions cannot write the same file at
  once; the second is refused instead of interleaving. Revisions are scoped to a
  single file, so `create.ts` can be revised while `index.php` is being reviewed,
  and each file keeps its own comments and revision history.
- **Pause, and "Change this", while a file is streaming.** Pause holds the stream
  where it is, leaving what has already been written in place — pausing is not an
  undo. "Change this" takes the partial file back off disk and turns your
  feedback into a revision of that same file, leaving the rest of the batch
  standing.
- **Generated code is commented in Persian as it is written.** Every class,
  method and non-obvious block gets a short Persian comment saying what it does
  and why it exists, with identifiers, keywords and error messages left in the
  language of the code. The instruction is part of the coding-mode prompt, so it
  applies to the code you review rather than to a separate explanation.
- **Code review happens in the editor.** The proposed file is opened in the real
  VS Code editor and streamed into it progressively, so you watch the file being
  written and can read, edit and compare it with the normal tooling, then approve,
  request changes or reject that file. The panel is for the conversation and the
  batch; the editor is where the code is reviewed.
- **A dangling planning hook was removed.** The working tree carried a call to
  `generateRoadmapIfNeeded()` with no implementation anywhere in the repository,
  plus a duplicate `roadmapGenerated` field. Both are gone. Planning output comes
  from the turn's own reply, as it does at `0.2.0`.

### Verification

- 1005 unit tests across 32 files (`npm test`).
- 12 cases in a real VS Code Extension Development Host (`npm run test:vscode`),
  including a seven-file batch written to disk and read back, a rejection that
  rolls one file back and leaves six intact, and two sessions contending for the
  same path. The multi-file write path is not covered by mocks alone.

## [0.2.0]

Two reported failures drove this release. Both were the same mistake in different
clothes: PairPilot asked the model for the wrong thing and then reported the
model's answer as a defect.

### Fixed

- **"Found valid JSON, but it is not a code_proposal object. PairPilot did not
  write anything. Try rephrasing the task."** The parser accepted a nested
  `proposal.changes[]` reply only if the changes sat at the document root, while
  models answer with the nested shape the surrounding ecosystem uses. Every turn
  also demanded a proposal, so typing `Hi` produced the same message. There is now
  one versioned contract, older shapes are adapted into it on arrival, and a
  reply that carries no proposal at all is read as the answer it is.
- **"The AI proposed a change without describing it."** When a proposal arrived
  with no prose, the adapter synthesised that summary and the developer saw an
  error for a reply that was structurally fine. A missing description is now
  filled from the proposal's own change descriptions, and the turn completes.
- **A planning request produced a code proposal.** Asking PairPilot to analyse
  requirements or discuss architecture — even after saying "do not write code
  yet" — routed the turn into code generation. See *Added* below.
- **Corrective retries never reached the model.** The retry loop asked the state
  machine for a `PROPOSING → PROPOSING` transition, which the machine refuses by
  design, so the attempt threw instead of re-requesting.
- **A conversational turn left the session busy.** `PROPOSING` had no edge to
  `COMPLETED`, so answering a greeting parked the machine in a state that locks
  the composer — the developer could not ask a second question.
- **Failures were reported without their detail.** Only the one-line reason
  reached the UI, so a schema failure read as an accusation with nothing
  actionable in it. The per-field issues are now shown.
- **Persian greetings were classified as engineering requests.** JavaScript
  defines `\b` over `[A-Za-z0-9_]`, so a word boundary never fires after a
  non-Latin letter and `سلام` matched no conversational pattern. Word-boundary
  checks around Persian text now use letter lookarounds.
- **A rejected multi-file proposal could be silently half-applied.** The parser
  searched for JSON fragments whenever the whole document failed validation, so
  one of the proposal's own changes could validate on its own and be staged. The
  whole document is now read first, and fragments are only considered when the
  reply contains no top-level JSON at all.

### Added

- **Four workflow modes** — Discovery, Architecture, Implementation planning and
  Coding — owned by the Extension Host, shown in the panel, and enforced twice:
  the prompt asks for the right answer and the host refuses anything else. A
  proposal that arrives during a planning turn is shown as a sketch without its
  file contents and dropped; nothing is staged and no file is created.
- **`architecture_discussion`**, a tenth message type. Planning needed somewhere
  to go that was neither a plan nor a proposal. It carries components,
  responsibilities, dependencies, rejected alternatives and open questions — and
  no file paths, operations or contents, so a directory layout drawn while
  designing cannot be mistaken for an instruction to create it.
- **An intention classifier** covering discovery, requirements, architecture,
  approval, implementation planning, code generation, modification, review and
  chat. It reads the instruction, the recent conversation and the session's mode
  — explicit instructions such as "do not write code yet" outrank everything, and
  an approval ("that architecture looks good") is never read as an authorisation
  to write.
- **A mode bar** in the panel header, so "will this write a file?" is answerable
  at a glance. The Webview only renders the mode it is sent; it never decides it.
- `CHANGELOG.md`.

### Changed

- A corrective retry names the offending field rather than saying "try again",
  and is bounded at two attempts — each one is a billed request.
- A reply that is plain text with no JSON is shown as the model's answer, with a
  notice that nothing was written, instead of being reported as a protocol error.

### Removed

- `src/proposals/ProposalParser.ts`, superseded by the `src/protocol/` package.

### Security

- Live code extraction is disabled during planning turns, so no half-file is
  streamed to the preview for a change that will not be offered.
- No new path, shell or credential surface. Planning modes call no writer.

## [0.1.1]

- Extension source, test suites and Marketplace icon.

## [0.1.0]

- First release.
