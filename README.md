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
2. The model returns a **structured proposal** — target path, operation
   (`create` or `update`), and the code.
3. Government of the target path is checked before you ever see it: it must be
   inside the workspace, must not be in a dependency or build directory, and must
   not be a credential.
4. **You approve the creation.** Nothing has been written yet.
5. The file is created **empty**, opened in the real editor, and the approved code
   is **streamed in progressively** as the model produces it.
6. **You approve the final code.** Only then does the state advance.
7. The **Engineering Advisor** recommends exactly one next step.

Reject at either gate and the write is rolled back — a created file is deleted, an
updated file is restored to its previous content.

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
| Credentials stay in the CLI | PairPilot never reads, stores, or forwards an API key. Your existing Claude Code configuration is used as-is. |
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

## Requirements

- VS Code 1.95 or newer
- A working **Claude Code CLI** on your `PATH`, already configured with your model
  and credentials. PairPilot shells out to it and never handles keys itself.

Verify the connection at any time with **PairPilot: Check Runtime**.

## Commands

| Command | Purpose |
| --- | --- |
| `PairPilot: Focus Sidebar` | Open the PairPilot view |
| `PairPilot: New Session` | Start a fresh session |
| `PairPilot: Resume Session` | Pick up a stored session |
| `PairPilot: Cancel Current Operation` | Abort the in-flight turn |
| `PairPilot: Revert Last Write` | Undo the most recent approved write |
| `PairPilot: Show Token Usage` | Session token and cost totals |
| `PairPilot: Check Runtime` | Verify the CLI is reachable |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pairpilot.runtime.claudePath` | `""` | Explicit CLI path. Empty means auto-detect. |
| `pairpilot.runtime.useBareMode` | `true` | Skip built-in prompt scaffolding and `CLAUDE.md` discovery. |
| `pairpilot.runtime.timeoutMs` | `300000` | Per-turn timeout. |
| `pairpilot.runtime.extraArgs` | `[]` | Extra CLI arguments. Safety-critical flags are refused. |
| `pairpilot.context.maxFiles` | `20` | Most files pinned into one turn. |
| `pairpilot.context.maxFileBytes` | `262144` | Per-file read ceiling. |
| `pairpilot.context.maxTotalChars` | `120000` | Total context budget. |
| `pairpilot.context.treeDepth` | `3` | Workspace tree summary depth. |
| `pairpilot.context.includeTree` | `true` | Include the file-name tree in context. |
| `pairpilot.safety.requireSensitiveFileApproval` | `true` | Prompt before reading a sensitive file. |
| `pairpilot.safety.allowSensitiveFileContext` | `false` | Allow sensitive files as context at all. |
| `pairpilot.advisor.enabled` | `true` | Recommend a next step after each approval. |
| `pairpilot.advisor.useAI` | `true` | Use the model; falls back to local analysis. |
| `pairpilot.session.maxHistory` | `50` | Stored sessions to retain. |

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
npm test                 # 278 unit and security tests
npm run test:live        # opt-in: 8 real-CLI protocol tests
npm run test:vscode      # opt-in: 9 extension-host tests
npm run package          # production build + VSIX
```

`npm test` runs without an editor host: the security-critical logic — path
containment, approval hashing, message validation, argument sanitisation, and the
streaming JSON scanner — is deliberately pure Node, so it is tested directly
rather than through a mocked `vscode` module.

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
  runtime/
    ClaudeCodeRuntime.ts    CLI discovery
    ClaudeSession.ts        spawn + NDJSON stream parsing
    processArgs.ts          argument and environment safety
  proposals/
    JsonStreamScanner.ts    incremental decoding of streamed JSON
    ProposalParser.ts       untrusted text -> candidate objects
    ProposalValidator.ts    candidate objects -> validated proposal
    ApprovalManager.ts      hash-bound, one-shot approvals
  editor/
    LiveWriter.ts           progressive writing + rollback
    DiffManager.ts          virtual-document diffs
  context/
    WorkspaceContext.ts     minimum-necessary context assembly
    FileReader.ts           bounded reads, binary detection
  storage/SessionStore.ts   session history
  ui/
    PairPilotProvider.ts    webview host, CSP
    WebviewMessageRouter.ts two-stage message validation
    webview/                the sidebar front end
```

The webview is untrusted. Every message it sends is shape-validated and then
state-validated before the Orchestrator sees it, and its CSP is `default-src
'none'` with a per-load nonce.

## License

MIT
