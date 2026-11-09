/**
 * Formatting helpers shared by everything that writes about a model or a cost
 * in prose — the Model Advisor's reasons, command toasts, and the tests that
 * assert on them.
 *
 * The rule these exist to enforce: **an absent value formats as a statement of
 * absence, never as a number.** `formatUsd(null)` returns "Unavailable", not
 * "$0.00" and not "". Every one of these functions is written so that a missing
 * value cannot accidentally render as a plausible-looking figure.
 */

/** Token counts with thousands separators, e.g. `1,000,000`. */
export function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'Not provided';
  }
  return Math.round(value).toLocaleString('en-US');
}

/**
 * A 0..1 ranking score, as a whole percentage.
 *
 * The word is "fit", not "quality", and the distinction is the point: the score
 * orders a shortlist against a task's stated requirements, so a bare "94%" beside
 * a model name would read as a grade of the model. The Model Advisor's disclaimer
 * travels with this string wherever it is shown.
 */
export function formatScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) {
    return 'Not scored';
  }
  return `${Math.round(Math.min(Math.max(score, 0), 1) * 100)}% fit`;
}

/** A token count in the compact form used in tables, e.g. `1M`, `128K`. */
export function formatTokensCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '—';
  }
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${trimZeros(millions)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${trimZeros(thousands)}K`;
  }
  return `${Math.round(value)}`;
}

/**
 * A price **per million tokens**, for display.
 *
 * Per-million is the convention developers read prices in; the stored value is
 * per token, and `perMillion` is applied here and nowhere else in the display
 * path so the two cannot be confused.
 */
export function formatPricePerMillion(perToken: number | null): string {
  if (perToken === null || !Number.isFinite(perToken)) {
    return 'Not provided';
  }
  const perMillion = perToken * 1_000_000;
  if (perMillion === 0) {
    return 'Free';
  }
  if (perMillion < 0.01) {
    return `$${perMillion.toFixed(4)}/M`;
  }
  if (perMillion < 1) {
    return `$${perMillion.toFixed(3)}/M`;
  }
  return `$${perMillion.toFixed(2)}/M`;
}

/**
 * A dollar amount.
 *
 * Small sums keep more precision, because a per-request cost of `$0.0004`
 * rounded to `$0.00` would read as free — the single most misleading thing this
 * view could do.
 */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'Unavailable';
  }
  const absolute = Math.abs(value);
  if (absolute === 0) {
    return '$0.00';
  }
  if (absolute < 0.01) {
    return `$${value.toFixed(6)}`;
  }
  if (absolute < 1) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

/** Elapsed time, e.g. `1.4s`, `2m 03s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'Not provided';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds - minutes * 60);
  return `${minutes}m ${`${remainder}`.padStart(2, '0')}s`;
}

/** A timestamp as a locale date-time, or a statement that there is none. */
export function formatTimestamp(at: number | null): string {
  if (at === null || !Number.isFinite(at) || at <= 0) {
    return 'Never';
  }
  return new Date(at).toLocaleString();
}

/** "3 minutes ago" style relative time, for "last refreshed" lines. */
export function formatRelative(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at) || at <= 0) {
    return 'Never';
  }
  const deltaMs = Math.max(0, now - at);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return 'Just now';
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function trimZeros(value: number): string {
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}
