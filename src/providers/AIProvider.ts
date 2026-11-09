/**
 * The provider seam.
 *
 * The interfaces themselves live in `types/provider.ts`, so that `types/` stays
 * the single dependency-free description of PairPilot's contracts — the same
 * reason `TokenUsage` and the state table live there. This module is the barrel
 * that provider implementations and the registry import from, so that
 * `providers/` reads as one directory with one entry point.
 *
 * Nothing here imports `vscode`, by design: see the note on `AIProvider`.
 */

export type {
  AIProvider,
  AIProviderStatus,
  AITurnHandle,
  AITurnRequest,
  ProviderId,
} from '../types/provider';
