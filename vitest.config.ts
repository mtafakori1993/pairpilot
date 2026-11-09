import { defineConfig } from 'vitest/config';

/**
 * The live integration suite talks to the real Claude Code CLI: it costs tokens
 * and takes tens of seconds per turn, so it must never run as part of `npm test`.
 *
 * The gate has to be applied through `include`/`exclude` rather than by passing a
 * path on the command line. Vitest's `exclude` wins over a positional filter, so
 * `vitest run test/integration` against an exclude list containing that directory
 * matches nothing at all and exits non-zero — a live-test command that silently
 * never runs a test is worse than no command, because it looks like a pass.
 */
const live = process.env['PAIRPILOT_LIVE_TESTS'] === '1';

export default defineConfig({
  test: {
    // The unit tests are pure Node: they deliberately avoid importing `vscode`,
    // so the security-critical logic can be tested without an editor host.
    environment: 'node',
    include: live
      ? ['test/integration/**/*.test.ts']
      : ['test/unit/**/*.test.ts', 'test/security/**/*.test.ts'],
    exclude: live ? ['node_modules/**'] : ['node_modules/**', 'test/integration/**'],
    reporters: 'default',
    // A live turn can take minutes, so the default is only right for unit tests.
    testTimeout: live ? 300_000 : 20_000,
  },
});
