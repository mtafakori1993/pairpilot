# PairPilot

A human-controlled AI pair programming extension for VS Code.

PairPilot puts a checkpoint between the AI and your filesystem. The model never
touches your code directly — it proposes, you review, and only then does anything
get written.

```
AI proposes  →  Human reviews  →  AI writes  →  Human approves  →  AI recommends
```

## The control loop

Every turn moves through explicit, visible states:

1. **Send a task** in the PairPilot sidebar.
2. The model returns a **structured proposal** — one or more files, each with a
   target path, an operation (`create` or `update`), and its code.
3. Government of every target path is checked before you ever see it: it must be
   inside the workspace, must not be in a dependency or build directory, and must
   not be a credential.
4. **You approve the batch.** Nothing has been written yet.
5. Each file is created **empty**, opened in the **real editor**, and the approved
   code is **streamed in progressively** as the model produces it. Watch it being
   written, then read and edit it with the ordinary VS Code tooling.
6. **You approve the final code, file by file.** Reject or request changes on one
   file and its siblings are untouched.
7. The **Engineering Advisor** recommends exactly one next step.

Reject at either gate and that write is rolled back — a created file is deleted,
an updated file is restored to its previous content.

### Reviewing in the editor, not the panel

The code is reviewed where it lives. The proposed file is opened in the actual
VS Code editor and written into it a chunk at a time, so you see the file
appearing rather than a preview of it. Generated code carries **Persian comments**
explaining each class, method and non-obvious block — what it does and why — with
identifiers, keywords and error messages left in the language of the code.

While a file is streaming you can:

- **Pause** — hold the stream where it is. What has already been written stays;
  pausing is not an undo.
- **Change this** — take the partial file back off disk and turn your feedback
  into a revision of *this* file.
- **Cancel** — stop the turn and roll the file back.

Before any of that, each file is a question of its own. When a proposal arrives,
PairPilot asks **permission to write**, in a native prompt that names the file and
what it will do, and nothing is written until you answer. The prompt opens on its
own; dismiss it by accident and `PairPilot: Review a Waiting File…` — or the
sidebar's button — brings it straight back. Three answers:

- **Write it** creates or rewrites that one file.
- **Request changes** sends the feedback back to the model for a revision of that
  file, without anything touching the disk.
- **Reject** ends the proposal. No file is created or modified.

With more than one file in flight a fourth button authorises the whole set in one
press. That is permission to write only: every file is still reviewed after it is
written, one at a time.

Once a file is written, its review opens **on that file**: a comment thread
anchored to the top of the document, holding the explanation the proposal gave and
the three decisions.

- **Approve** keeps the file.
- **Request changes** describes a correction; only that file is rewritten, and it
  comes back for review again.
- **Reject** takes the unapproved code back off disk.

The same three are on the thread's menu, and `PairPilot: Review a Waiting File…`
finds a review whose thread has scrolled out of view. The sidebar shows a review's
*status* and a button that opens the editor — it has no way to approve anything,
because the request protocol the panel speaks has no vocabulary for a decision.
A panel cannot approve a file even if it wanted to.

A decision is refused, with the reason named, when the content it would approve is
no longer the content on screen: edit the file after the review opens and the
review is retired rather than applied. Each file's session is keyed by its
document, so revising `create.ts` does not disturb `index.php`, two sessions
cannot write the same path at once, and switching tabs never loses a review.

Nothing is ever overwritten without authorisation: an existing file is replaced
only by an `update` proposal you approved, and a `create` over an existing file is
refused outright.

### Following a roadmap

If the workspace has a `ROADMAP.md` (also `docs/ROADMAP.md` or
`.pairpilot/ROADMAP.md`), it becomes the plan the coding turn follows. The grammar
is meant to be written by hand:

```markdown
### models — Domain models
- status: todo
- files: src/User.php, src/Order.php
- depends-on: schema
```

Each task lists the files it owns, in order, and the tasks it depends on. After you
approve a file PairPilot updates that task's status, then offers the next file —
the next file of the same task, or the first file of the next task whose
dependencies are all done.

Two rules keep the file honest:

- **`done` requires verification.** When a task's last file is approved you are
  asked, in a modal, whether the work passed its checks. If you have not verified
  it, the task stays `in_progress` and no next task is started. Approved is not
  done.
- **Nothing is skipped.** A task is next only when every task it depends on is
  `done`; a dependency on a task that does not exist is reported rather than
  quietly ignored.

The edit is a normal `WorkspaceEdit`, so the status change is a diff you can undo,
and it rewrites the one `status:` line — your prose is untouched. The status is
read fresh each turn, so editing the roadmap while PairPilot runs takes effect on
the next file rather than after a reload.


### The batch record

A multi-file proposal gets a persistent record, held by the Extension Host and
rendered by the panel: a batch id, the proposal id and version, and for each file
its id, path, operation, content hash, status (`pending`, `writing`, `completed`,
`failed`) and any note. The panel does not own this — reload it and the same
picture comes back.

Decisions are bound to that record, not just to the bytes. A decision may state
which proposal, which version and which file it is deciding on, and each is
checked against the host's own store: a superseded version is refused, a file id
from a different proposal is refused, and the file that gets written is the one
the host has on record. The host never treats "approved" as sufficient on its own,
and never creates a placeholder file in place of content that did not arrive.

## Workflow modes: planning never becomes coding by accident

PairPilot is not a single "do whatever the model says" loop. Every session is in
one of four modes, shown in a bar under the header, and the mode decides what a
turn may produce.

| Mode | What it does | Can it write? |
| --- | --- | --- |
| **Discovery** | Establishes what you want to build. Summarises requirements, asks the one question that changes the design. | No |
| **Architecture** | Designs the shape of the system with you: components, responsibilities, dependencies, rejected alternatives. | No |
| **Implementation planning** | Turns the agreed design into ordered work with a way to tell each piece is finished. | No |
| **Coding** | Proposes real files, which you review and approve one gate at a time. | Yes |

**A request to think is not a request to build.** If you ask PairPilot to analyse
requirements or discuss architecture, or say "do not write code yet", it stays in
a planning mode however clear the design becomes. That instruction is read from
your words — in English or Persian — and it outranks everything else the turn
mentions, because you stated the rule directly.

**A wish is not an instruction.** "I want to build a user management system" is
the opening line of a planning conversation, so it settles requirements and does
nothing else. Saying "go ahead and implement it" is what moves the session to
Coding — and it is a separate instruction, never a side effect of agreeing with a
design. Approving an architecture hands you the roadmap and stops there.

**The mode is enforced twice.** The prompt asks for the right kind of answer, and
then the host refuses anything else: a `code_proposal` that arrives during a
planning turn is validated, shown to you as a sketch *without its file contents*,
and dropped. Nothing is staged, nothing is approved, and no file exists
afterwards. You can see what the model wanted to build; you are simply not asked
to authorise it.

**The Webview never owns the mode.** It renders the mode the Extension Host
reports and nothing more, so a stale or hostile panel cannot offer an approval
button for work the host would refuse.

## Guarantees

These are structural, not policy. They hold because the code makes the unsafe
outcome unrepresentable or unreachable, not because a prompt asks nicely.

| Guarantee | How it is enforced |
| --- | --- |
| AI cannot write files itself | The CLI is spawned with `--tools ""`, disabling every built-in tool. PairPilot is the only writer. |
| Approval binds to exact content | Each approval records a SHA-256 over operation + path + code. A change to any of those invalidates it. Replay is refused. |
| No path escapes the workspace | Lexical containment **and** a `realpath` symlink check, so a symlinked directory cannot smuggle a write outside. |
| Deletion is impossible | `delete` is absent from the operation type union. It cannot be expressed, let alone approved. |
| No silent overwrite | A `create` over an existing file is refused; overwriting requires an explicit `update` proposal you can review as a diff. |
| No shell injection | `spawn` with an argument array and `shell: false`. No shell ever parses a task description. |
| Prompts never enter `argv` | The prompt travels on stdin, which also removes the `ARG_MAX` ceiling. |
| Credentials are never in the clear | The Claude Code CLI's credentials stay with the CLI. An OpenRouter key, if you configure one, is held in VS Code's encrypted `SecretStorage`, read only in the Extension Host at the moment a request is made, and rendered in the UI as a locally-computed mask. Nothing logs it, no error message contains it, and no message sent to a Webview can carry it. |
| No invented numbers | When the runtime reports no usage, the UI says **"Usage unavailable"**. Token counts are never estimated. |
| Config cannot weaken guarantees | Arguments that would re-enable tools, widen filesystem access, or bypass permissions are refused rather than ignored. |

### What PairPilot never does

No arbitrary shell execution. No automatic package installation. No Git commit or
push. No migrations. No file deletion. No silent creation of supporting files.

## Context handling

PairPilot sends the **minimum relevant context**, never the whole workspace. You
pin the files you want considered. Excluded by default: `.env` files, private
keys, credentials, `node_modules`, `vendor`, `.git`, and build output.

Sensitive files are hidden from the model entirely — they do not even appear in
the workspace tree summary, so the model cannot learn they exist. Reading one into
context requires your explicit approval.

## AI providers and models

PairPilot runs its turns on one provider at a time. Choosing a provider or a model
happens entirely in **native VS Code prompts** — a QuickPick for the provider, a
searchable list for a model, a password field for a key — because a catalogue of
hundreds of models was never going to fit in a small sidebar. The sidebar carries
one line: the active provider and model, with a button that opens the same flow.

`PairPilot: Select Provider…` switches the provider; `PairPilot: Select Model…`
picks one for a whole workflow step or for everything (see
[Model selection](#model-selection) below). A status-bar item shows the current
choice and opens the picker when clicked.

| Provider | Credential | Model catalogue |
| --- | --- | --- |
| Claude Code CLI | None — it signs in itself | None published; it chooses its own model |
| OpenRouter | An API key you paste, kept in VS Code's encrypted `SecretStorage` | Fetched from `GET /models` |

### Setting up OpenRouter

1. Create a key at <https://openrouter.ai/keys> (`PairPilot: Open OpenRouter Key
   Page`).
2. Press **Set API key** on the provider card, or run `PairPilot: Set or Replace
   Provider API Key…`. The prompt is a password field: the value is never rendered
   on screen, and the stored key is never placed in it as a default.
3. The key is validated immediately with `GET /key`, and the card reports what the
   provider said — accepted, rejected, or not yet tested — along with the plan, the
   key's usage and any limit the account reports.

**No key is required to look around.** `GET /models` is public, so the model list
and the Model Advisor are fully usable before you configure anything. The provider
choice reports a setup state, not an error.

**Replace API key** writes a new key over the old one; **Disconnect** deletes it
after a confirmation, and PairPilot cannot recover it afterwards.

### What is stored, and where

The key lives only in `SecretStorage`. It is read in exactly one place — the API
client, at the moment it builds a request — and the only key-derived value that
reaches the Webview is the mask the Host computes (`sk-or-…a1b2`). Keys are never
written to `settings.json` or `package.json`, never logged, never included in an
error, and never sent anywhere except the provider they belong to.

### Choosing a model

`PairPilot: Select Model…` runs one hierarchical QuickPick flow, which is what
keeps a catalogue of hundreds of models navigable in a small window:

1. **Which step** — Planning, Coding, Code review, another role, the global
   default, or a project-level choice when a folder is open.
2. **Filters** — the quick filters below, applied inside the list.
3. **Search** — type to filter by name, id or developer; the list only ever shows
   what matches.
4. **Confirm** — the choice is written at the level you picked, then the status bar
   and sidebar update.

Choosing **Automatic** at any level clears it, so it follows the level above.
Selections persist across restarts; with nothing stored at any level the turn runs
on the provider's own default.

Every field in the list comes from the catalogue. Prices are displayed **per
million tokens** — the convention developers read — while the stored value is per
token; the conversion happens once, in the Host. A price the catalogue did not
publish reads **Not provided**, never `$0.00`, which would read as free. A model
whose context window is unknown shows `—`.

Nine quick filters, each one a rule over a catalogue field:

| Filter | Rule |
| --- | --- |
| Coding | Publishes tool calling or structured output in its supported parameters. |
| Reasoning | Publishes a reasoning parameter block or a reasoning parameter. |
| Low Cost | Input priced at or below $1.00 per million tokens. |
| Large Context | Advertises a context window of 200,000 tokens or more. |
| Vision | Accepts image input. |
| Audio | Accepts audio input, or produces audio output. |
| Tool Calling | Publishes the `tools` parameter. |
| Structured Output | Publishes `structured_outputs` or `response_format`. |
| Free | Priced at exactly zero for both input and output. |

There is deliberately **no "Fast" filter**. The catalogue publishes no latency or
throughput figure, so any such filter would have to rank on something other than
the data — and a filter named "Fast" that ranked on price or context size would be
a guess wearing a fact's clothes.

Search, sort, favourites and "recently used" are all local to your machine. The
"Recently used" row lists the models a turn has actually run on, most recent
first; choosing a model in the selection screen does not add it, because a model
picked and never tried should not outrank one that just wrote code. The
catalogue itself is cached in `globalState` and refreshed at most every
`pairpilot.providers.catalogRefreshHours`; a refresh that fails **keeps the models
already loaded** and marks them out of date rather than emptying the list.

### The Model Advisor

Pick a kind of work — Product Discovery, Architecture Design, Coding, Code Review,
Simple Questions, Documentation, or Large Repository Analysis — and the Advisor
ranks the catalogue against the requirements that task implies, stating those
requirements explicitly and listing what you give up with each suggestion.

The score is a **fit against those stated requirements, computed from catalogue
metadata**. It is not a measurement of how well a model writes code, and PairPilot
has not benchmarked anything. The disclaimer travels with every score.

**PairPilot never switches models on its own.** Applying a recommendation writes a
selection; nothing else changes models.

### Model selection and inheritance

A model is chosen at one of four levels, most specific first:

| Level | Applies to |
| --- | --- |
| Task | One kind of work |
| Role | Coding, Code Review, and the other roles |
| Project | The workspace folder you have open |
| Global | Everything else |

The panel shows every level, what it currently holds, and which model the next
coding turn will resolve to and why. A level pointing at a model the catalogue no
longer carries is flagged, and cleared automatically when the catalogue changes,
so a stale selection cannot become a confusing provider-side error at your next
request.

Two roles — Coding and Code Review — are read by a workflow today. The rest are
stored preferences that nothing acts on yet, and the panel says so on each row
rather than implying a screen exists behind them.

## Cost and usage

**Cost & Usage** records one row per completed AI request: model, provider, role,
task, input and output tokens, cached tokens, duration, timestamp, and a cost.

Every figure is one of exactly three things, and the view always says which:

- **Reported** — the provider told PairPilot what it charged.
- **Estimated** — PairPilot multiplied the token counts by the prices published in
  the catalogue at the time of the request. This is arithmetic on a price list,
  and it can differ from your invoice.
- **Unavailable** — neither was possible. The total reads `Unavailable`, never
  `$0.00`.

A partial total says so in the same breath as the figure ("3 of 40 requests could
not be priced and are not included"), because a number without that qualifier
reads as the whole bill. Nothing is re-priced at display time: a request recorded
without a price keeps none, rather than being re-derived against today's
catalogue.

The dashboard shows totals, this-session and this-project spend, cost by model,
provider and role, a 7/30/90-day daily chart, and the most recent requests. A day
whose cost could not be established is drawn as an unknown bar, never as a short
one — and a day with no requests is drawn as nothing at all, because those are
different facts.

`pairpilot.cost.budgetUsd` sets a figure to be **warned** about. It is a
notification, not a gate: PairPilot does not block or postpone a request on cost,
and the panel says so next to the limit. Usage history is stored locally, in
`globalState`, capped at `pairpilot.cost.historyLimit` rows, and never sent
anywhere. `PairPilot: Clear Usage History…` erases it after a confirmation; that
changes nothing at the provider.

## Requirements

- VS Code 1.95 or newer
- A working **Claude Code CLI** on your `PATH`, already configured with your model
  and credentials. PairPilot shells out to it and never handles keys itself.
  OpenRouter is optional: without it, everything except remote-provider turns
  still works, including the model list and the Model Advisor.

Verify the connection at any time with **PairPilot: Check AI Runtime**.

## Commands

| Command | Purpose |
| --- | --- |
| `PairPilot: Focus Sidebar` | Open the PairPilot view |
| `PairPilot: New Session` | Start a fresh session |
| `PairPilot: Resume Session…` | Pick up a stored session |
| `PairPilot: Cancel Current Operation` | Abort the in-flight turn |
| `PairPilot: Revert Last Unapproved Write` | Undo the most recent approved write |
| `PairPilot: Show Token Usage` | Session token and cost totals |
| `PairPilot: Check AI Runtime` | Verify the CLI is reachable |
| `PairPilot: Select Provider…` | Choose the active provider |
| `PairPilot: Select Model…` | Choose a model for a step, or the global default |
| `PairPilot: Select Global Model…` | Choose the model every turn falls back to |
| `PairPilot: Select Planning Model…` | Choose the model for planning turns |
| `PairPilot: Select Coding Model…` | Choose the model for coding turns |
| `PairPilot: Select Review Model…` | Choose the model for review and advice |
| `PairPilot: Review a Waiting File…` | Raise the prompt that is waiting — permission to write, or a written file's review |
| `PairPilot: Approve Review` | Approve the review for the active file (thread menu) |
| `PairPilot: Reject Review` | Reject it, removing the unapproved code (thread menu) |
| `PairPilot: Request Changes to Review` | Describe a correction for it (thread menu) |
| `PairPilot: Show Cost & Usage` | Open the cost dashboard |
| `PairPilot: Set or Replace Provider API Key…` | Store or replace an OpenRouter key |
| `PairPilot: Test Provider Connection` | Validate the stored key against the provider |
| `PairPilot: Disconnect Provider and Delete Stored Key…` | Delete the stored key |
| `PairPilot: Refresh Model Catalog` | Re-fetch the model catalogue |
| `PairPilot: Clear Usage History…` | Erase the local usage record |
| `PairPilot: Open Provider Settings` | Jump to the provider settings |
| `PairPilot: Open OpenRouter Key Page` | Open <https://openrouter.ai/keys> in a browser |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pairpilot.runtime.claudePath` | `""` | Explicit CLI path. Empty means auto-detect. |
| `pairpilot.runtime.useBareMode` | `true` | Skip built-in prompt scaffolding and `CLAUDE.md` discovery. |
| `pairpilot.runtime.timeoutMs` | `300000` | Per-turn timeout. |
| `pairpilot.runtime.extraArgs` | `[]` | Extra CLI arguments. Safety-critical flags are refused. |
| `pairpilot.context.maxFiles` | `12` | Most files pinned into one turn. |
| `pairpilot.context.maxFileBytes` | `65536` | Per-file read ceiling. |
| `pairpilot.context.maxTotalChars` | `120000` | Total context budget. |
| `pairpilot.context.treeDepth` | `3` | Workspace tree summary depth. |
| `pairpilot.context.includeTree` | `true` | Include the file-name tree in context. |
| `pairpilot.safety.requireSensitiveFileApproval` | `true` | Prompt before reading a sensitive file. |
| `pairpilot.safety.allowSensitiveFileContext` | `false` | Allow sensitive files as context at all. |
| `pairpilot.advisor.enabled` | `true` | Recommend a next step after each approval. |
| `pairpilot.advisor.useAI` | `true` | Use the model; falls back to local analysis. |
| `pairpilot.session.maxHistory` | `50` | Stored sessions to retain. |
| `pairpilot.providers.activeProvider` | `claude-code` | Which provider receives turns: `claude-code` or `openrouter`. |
| `pairpilot.providers.openrouter.enabled` | `true` | Whether OpenRouter may receive turns. Switching it off keeps the card listed (as switched off) and keeps a stored key; the public catalogue still refreshes. |
| `pairpilot.providers.openrouter.baseUrl` | `https://openrouter.ai/api/v1` | API base URL. |
| `pairpilot.providers.openrouter.maxOutputTokens` | `0` | Output ceiling per request. `0` uses the provider's own default. |
| `pairpilot.providers.catalogRefreshHours` | `12` | Hours before the catalogue is considered stale. `0` turns automatic refreshing off; the catalogue is then fetched only when you ask. |
| `pairpilot.cost.budgetUsd` | `0` | Warn once per session above this spend. `0` disables the warning. Never blocks a request. |
| `pairpilot.cost.historyLimit` | `500` | Usage rows retained locally. |

## Installation

From the Marketplace, search for **PairPilot**, or install by identifier:

```bash
code --install-extension mtafakori1993.pairpilot
```

From source:

```bash
npm install
npm run package          # produces pairpilot.vsix
code --install-extension pairpilot.vsix
```

To develop: `npm run watch`, then press <kbd>F5</kbd> to launch an Extension
Development Host.

## Development

```bash
npm run typecheck        # tsc --noEmit
npm test                 # 1040 unit and security tests
npm run test:live        # opt-in: 8 real-CLI protocol tests
npm run test:vscode      # opt-in: 12 extension-host tests
npm run package          # production build + VSIX
```

`npm test` runs without an editor host: the security-critical logic — path
containment, approval hashing, message validation, argument sanitisation, and the
streaming JSON scanner — is deliberately pure Node, so it is tested directly
rather than through a mocked `vscode` module.

The response protocol is tested the same way, and it is the part with the most
tests per line of code, because it is where a model's reply becomes something
PairPilot will act on. Three layers are pinned separately: extraction (a payload
wrapped in prose, a fenced block, braces inside source strings), adaptation (the
shapes a model actually sends — a nested `proposal`, a change list under `files`,
a path spelled `fileName`, content as an array of lines), and validation (which
fields a change must carry, and what the diagnostic says when one is missing).

The provider and model subsystem is built the same way, which is why it is
testable at all: catalogue normalisation, search, advisor scoring, selection
inheritance, cost arithmetic and both view builders take their inputs as
arguments and import no `vscode`. Its API tests run against **mocked OpenRouter
responses**, so the whole suite passes with no key configured and no network. The
panels themselves are covered as files by `test/security/WebviewPanels.test.ts`,
which reads the scripts and stylesheets and asserts what they may not contain.

Two further suites are opt-in, because each needs something `npm test` cannot
have.

**`npm run test:live`** (set `PAIRPILOT_LIVE_TESTS=1`) exercises the real CLI, so
it costs tokens and needs working credentials. It validates the protocol
assumptions the extension depends on against the runtime itself, rather than
against fixtures shaped like it:

- streaming really is incremental, and the deltas reconstruct the final text;
- `session_id` is reported, and `--resume` really restores context;
- usage is genuinely reported, so the token figures are measured;
- **`--tools ""` really does stop the model writing files.** This is the
  load-bearing assumption of the whole approval workflow, so it is asserted
  against the filesystem rather than against anything the model says.

**`npm run test:vscode`** launches an Extension Development Host with a throwaway
profile and a temporary workspace, and runs inside it. It covers what only a live
editor can: that the extension activates, that every command and the sidebar view
are registered, that runtime detection reaches the CLI from inside the host, that
a create writes code into a **real** `TextDocument` progressively (not one paste),
that a large stream lands byte-identically, and that both rollback paths — delete
a created file, restore an updated one — behave.

It also covers the multi-file path, because that is where the reported failures
were and the batch ledger's bookkeeping is only half the story: **all seven files
of a batch are written into the real workspace** and read back from disk, a
**rejection rolls back one file and leaves the other six exactly as they were**,
and **two review sessions cannot write the same path at once**. The rollback case
asserts the `TextDocument` holds the proposed code and nothing else, which is what
catches an `update` that appends instead of replacing.

It launches the **Electron binary** (`VSCode-linux-x64/code`), not the `bin/code`
wrapper. The wrapper runs `resources/app/out/cli.js`, which hands the request to a
GUI process and exits immediately, so a run against it reports success having
executed nothing at all. Override the location with `PAIRPILOT_VSCODE_EXECUTABLE`
if VS Code lives elsewhere.

Both suites are excluded from `npm test`, and `test:vscode` builds to `out-test/`,
which is excluded from the VSIX.

### What these suites have caught

Worth recording, because it is the argument for having them:

- **The writer reported success without saving.** `complete()` applied a
  `WorkspaceEdit`, which only mutates the in-memory text model. For a `create`,
  the file on disk stayed **empty** — so the Orchestrator's read-back
  verification compared the reviewed code against an empty file and rolled every
  write back as failed. No unit test could see this, because saving is host-only
  behaviour.
- **Overlapping flushes could scramble a file.** `flush()` computes an insertion
  offset and *then* awaits `applyEdit`, so two overlapping flushes can insert out
  of order. The 40ms debounce usually separates them; under load it does not. The
  fix serialises flushes; the progressive-write test fails without it.
- **An approved batch of seven wrote one file and lost six.** Requesting changes
  to a single file sent the turn back through the proposal stage, which rebuilt
  the batch from a reply that contained one file. The other six vanished from the
  ledger, so the next authorization had nothing to resolve content from — and the
  reported symptom, "no file contents were sent", was the *correct* refusal at the
  end of a pipeline that had already lost the content two stages earlier. The unit
  tests for the batch all passed throughout, because the defect was in how the
  Orchestrator *called* the queue, not in the queue.
- **A refused `WorkspaceEdit` dropped the chunk.** VS Code refuses an edit whose
  document moved in the meantime — which creating the file itself causes. `flush()`
  cleared its buffer before applying, so the refused characters existed nowhere,
  and the stream reported success having written less than the proposal. The
  buffer is now consumed only after a successful apply, and the writer waits for the
  document to settle before installing its manual-edit guard.
- **Every `update` rolled back as a failure.** The writer inserted at the end of
  the document while the old content was still in it, so the file on disk never
  matched the proposal and the read-back verification rejected it. An `update`
  could not succeed at all. Only the editor-host suite could see this, because the
  defect is in what a real `TextDocument` contains after an edit.
- **A reply was refused for a field it had, under another name.** A model that
  wrote `fileName` instead of `file` had its whole proposal rejected with
  "The "file" field is required and was not present" — true, and useless: it did
  not say which change, did not say what had arrived, and did not name the shape
  expected. The alias list stopped one spelling short of what models write, and
  the message described the absence rather than the difference. Both halves are
  fixed: the spelling is read, and a path that is genuinely absent is reported
  with the keys that did arrive and the structure that was expected.
- **A recognised shape was discarded one stage later.** Adaptation accepted a
  change list sent under `files` and nothing renamed it, so validation refused the
  reply for carrying no `changes`. The model was blamed for a reply the pipeline
  had already understood — the same defect as the batch one above, one layer down:
  the two stages disagreed about what they were passing.

## Architecture

```
src/
  extension.ts              activation, configuration, wiring
  core/
    Orchestrator.ts         the authority: owns every state transition
    StateMachine.ts         whitelist transition table
    EngineeringAdvisor.ts   next-step recommendation
  security/
    PathGuard.ts            the single path choke point
    MessageValidator.ts     webview message trust boundary
    SecretManager.ts        the only code allowed to touch an API key
  runtime/
    ClaudeCodeRuntime.ts    CLI discovery
    ClaudeSession.ts        spawn + NDJSON stream parsing
    processArgs.ts          argument and environment safety
    prompts.ts              prompt construction
  proposals/
    JsonStreamScanner.ts    incremental decoding of streamed JSON
    TurnInterpreter.ts      reply -> proposal / narrative / advice / question / failure
    ProposalValidator.ts    candidate objects -> validated proposal
    ApprovalManager.ts      hash-bound, one-shot approvals
  editor/
    LiveWriter.ts           progressive writing + rollback
    DiffManager.ts          virtual-document diffs
  context/
    WorkspaceContext.ts     minimum-necessary context assembly
    FileReader.ts           bounded reads, binary detection
  providers/
    AIProvider.ts           the provider seam
    ProviderRegistry.ts     the known providers, and which one is active
    ClaudeCodeProvider.ts   the CLI, seen as a provider
    OpenRouterClient.ts     models, key and chat, with SSE streaming
    OpenRouterProvider.ts   OpenRouter, seen as a provider
    HttpTransport.ts        injectable HTTP, and the SSE parser over it
  models/
    ModelMetadata.ts        catalogue -> ModelMetadata
    ModelRegistry.ts        the cached catalogue and its refresh policy
    ModelSearch.ts          search, filters, sorts
    ModelAdvisor.ts         "why should I use this model?"
    ModelSelectionService.ts  task -> role -> project -> global inheritance
    format.ts               one house style for prices, tokens and scores
  pricing/
    CostCalculator.ts       tokens and published prices -> a cost
    UsageTracker.ts         the record of requests, and its aggregates
  orchestration/
    AIOrchestrator.ts       the one place a turn is started
  storage/SessionStore.ts   session history
  commands/
    index.ts                command palette and view-title actions
    management.ts           provider, model and cost commands
  protocol/
    types.ts                the canonical, versioned message contract
    schema.ts               runtime validation with per-field diagnostics
    adapt.ts                rewriting older shapes into the canonical one
    parse.ts                extracting JSON from whatever text arrived
    classify.ts             deciding which type a turn should ask for
    mode.ts                 workflow modes, intention classification, policy
    diagnostics.ts          a bounded, redacting record of recent replies
  types/                    dependency-free contracts
  ui/
    PairPilotProvider.ts    the sidebar webview host, CSP
    WebviewMessageRouter.ts two-stage message validation
    WebviewAssets.ts        nonce, template substitution, fallback page
    ManagementController.ts the composition root for providers and models
    ProviderViewBuilder.ts  everything the Providers screen renders
    CostViewBuilder.ts      everything the Cost & Usage screen renders
    ProviderMessages.ts     the management panels' message contract
    PanelNotices.ts         the management panels' own sentences
    ProviderManagementProvider.ts  the "AI Providers & Models" webview
    CostDashboardProvider.ts       the "Cost & Usage" webview
    webview/                the front ends for all three webviews
```

The webview is untrusted. Every message it sends is shape-validated and then
state-validated before the Orchestrator sees it, and its CSP is `default-src
'none'` with a per-load nonce.

The two management panels follow the same rules with one addition of their own:
**every figure and every sentence arrives pre-formatted from the Extension Host.**
The panels place text and nothing else, so an unknown cost cannot become `$0.00`
inside a panel that never sees `0` — `test/security/WebviewPanels.test.ts` fails
the build if a panel script regains a formatter or reads a raw figure.

## License

MIT
