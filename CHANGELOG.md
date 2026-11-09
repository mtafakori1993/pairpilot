# Changelog

All notable changes to PairPilot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
