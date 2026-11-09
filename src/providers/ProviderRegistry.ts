/**
 * ProviderRegistry — the set of known providers, and which one is active.
 *
 * The Orchestrator asks the registry for the active provider at the moment it
 * needs one, rather than holding a provider directly. That is what makes
 * switching providers a registry operation instead of an Orchestrator rebuild,
 * and it is where model selection will hang off in a later phase.
 *
 * The registry also owns the translation between provider-neutral status and the
 * Webview's existing `RuntimeStatus` shape, so that no UI code has to learn the
 * provider vocabulary yet.
 */

import { RuntimeError } from '../core/errors';
import type { RuntimeStatus } from '../types';
import type { AIProvider, AIProviderStatus, ProviderId } from './AIProvider';

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();
  private readonly subscriptions = new Map<ProviderId, { dispose(): void }>();
  private readonly activeListeners = new Set<(provider: AIProvider) => void>();
  private readonly statusListeners = new Set<(status: AIProviderStatus) => void>();
  private activeId: ProviderId | null = null;

  /** Register a provider. The first one registered becomes active. */
  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
    this.subscriptions.set(
      provider.id,
      provider.onDidChangeStatus((status) => {
        // Only the active provider's status reaches the UI: a background
        // provider must not make the header flicker.
        if (provider.id === this.activeId) {
          for (const listener of this.statusListeners) {
            listener(status);
          }
        }
      })
    );
    if (this.activeId === null) {
      this.activeId = provider.id;
    }
  }

  list(): AIProvider[] {
    return [...this.providers.values()];
  }

  get activeProviderId(): ProviderId | null {
    return this.activeId;
  }

  /** The active provider, or null when none is registered. */
  tryActive(): AIProvider | null {
    if (this.activeId === null) {
      return null;
    }
    return this.providers.get(this.activeId) ?? null;
  }

  /**
   * The active provider.
   *
   * Throws when there is none. That can only happen if activation failed to
   * register one, so it is a wiring bug rather than a user-facing condition —
   * which is why it does not degrade to a soft "unavailable" status.
   */
  active(): AIProvider {
    const provider = this.tryActive();
    if (!provider) {
      throw new RuntimeError(
        'No AI provider is registered. This is a PairPilot wiring fault, not a settings problem.'
      );
    }
    return provider;
  }

  /** True when the active provider currently reports itself usable. */
  isActiveAvailable(): boolean {
    return this.tryActive()?.getStatus().available ?? false;
  }

  /**
   * The active provider's status in the Webview's existing shape.
   *
   * The no-provider case is answered here rather than at the call site, so that
   * "nothing is registered" is described once, and honestly, instead of every
   * consumer inventing its own placeholder.
   */
  activeRuntimeStatus(): RuntimeStatus {
    const provider = this.tryActive();
    if (!provider) {
      return { available: false, message: 'No AI provider is registered.', pending: false };
    }
    return toRuntimeStatus(provider.getStatus());
  }

  /** Make another provider active. Returns false when it is not registered. */
  select(id: ProviderId): boolean {
    if (!this.providers.has(id)) {
      return false;
    }
    if (id === this.activeId) {
      return true;
    }
    this.activeId = id;
    const provider = this.providers.get(id) as AIProvider;
    for (const listener of this.activeListeners) {
      listener(provider);
    }
    // Publish the new provider's status immediately, so the header does not keep
    // showing the previous provider's until something else happens to refresh.
    for (const listener of this.statusListeners) {
      listener(provider.getStatus());
    }
    return true;
  }

  onDidChangeActive(listener: (provider: AIProvider) => void): { dispose(): void } {
    this.activeListeners.add(listener);
    return { dispose: () => void this.activeListeners.delete(listener) };
  }

  onDidChangeStatus(listener: (status: AIProviderStatus) => void): { dispose(): void } {
    this.statusListeners.add(listener);
    return { dispose: () => void this.statusListeners.delete(listener) };
  }

  dispose(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.dispose();
    }
    this.subscriptions.clear();
    for (const provider of this.providers.values()) {
      provider.dispose?.();
    }
    this.providers.clear();
    this.activeListeners.clear();
    this.statusListeners.clear();
    this.activeId = null;
  }
}

/**
 * Present a provider status in the Webview's existing `RuntimeStatus` shape.
 *
 * The panel contract is deliberately left untouched in this block — no Webview,
 * CSP or message-router change — so that the refactor cannot alter what the
 * developer sees. A later phase replaces this with a provider-aware section of
 * the snapshot, at which point `executablePath` stops being the right field for
 * a remote provider.
 */
export function toRuntimeStatus(status: AIProviderStatus): RuntimeStatus {
  return {
    available: status.available,
    message: status.message,
    ...(status.executablePath !== undefined ? { executablePath: status.executablePath } : {}),
    ...(status.version !== undefined ? { version: status.version } : {}),
    ...(status.pending !== undefined ? { pending: status.pending } : {}),
  };
}
