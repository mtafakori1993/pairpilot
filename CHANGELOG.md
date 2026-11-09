# Changelog

All notable changes to PairPilot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
- **A missing content hash was not the failure it looked like.** A decision that
  arrived without matching content is now refused with the file and the stage
  named, rather than a generic message. No placeholder or empty file is ever
  created as a substitute for content that did not arrive.

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
