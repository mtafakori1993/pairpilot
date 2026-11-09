/**
 * Provider registry and provider-status translation tests.
 *
 * Two rules are under test here, and both are about not lying to the developer:
 *
 *  1. The registry is the single authority on which backend is active. Nothing
 *     downstream should be able to disagree with it, and switching must be a
 *     registry operation rather than an Orchestrator rebuild.
 *  2. Status translation never invents a value the provider did not report. An
 *     unset version must stay *absent*, not become an empty string that the UI
 *     would happily render as a version number.
 *
 * These run in plain Node: neither the registry nor the types it uses import
 * `vscode` — which is the property that lets the provider seam be tested without
 * an editor, and a later provider be tested without a network.
 */

import { describe, expect, it } from 'vitest';

import { ProviderRegistry, toRuntimeStatus } from '../../src/providers/ProviderRegistry';
import type {
  AIProvider,
  AIProviderStatus,
  AITurnRequest,
  ProviderId,
} from '../../src/providers/AIProvider';
import { emptyUsage } from '../../src/types';

interface FakeProvider extends AIProvider {
  readonly calls: {
    detect: number;
    requireAvailable: number;
    startTurn: AITurnRequest[];
    cancel: number;
  };
  /** Simulate the provider changing its own status. */
  emitStatus(overrides?: Partial<AIProviderStatus>): void;
}

function fakeProvider(id: ProviderId, overrides: Partial<AIProviderStatus> = {}): FakeProvider {
  const listeners = new Set<(status: AIProviderStatus) => void>();
  let status: AIProviderStatus = {
    id,
    label: id,
    available: true,
    message: `${id} is ready`,
    ...overrides,
  };

  const calls = { detect: 0, requireAvailable: 0, startTurn: [] as AITurnRequest[], cancel: 0 };

  const provider: FakeProvider = {
    id,
    label: id,
    calls,
    getStatus: () => status,
    detect: async () => {
      calls.detect += 1;
      return status;
    },
    requireAvailable: () => {
      calls.requireAvailable += 1;
    },
    startTurn: (request: AITurnRequest) => {
      calls.startTurn.push(request);
      return {
        result: Promise.resolve({
          text: '',
          usage: emptyUsage(),
          isError: false,
          cancelled: false,
        }),
        cancel: () => {
          calls.cancel += 1;
        },
        isRunning: false,
      };
    },
    onDidChangeStatus: (listener) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    emitStatus: (over = {}) => {
      status = { ...status, ...over };
      for (const listener of listeners) {
        listener(status);
      }
    },
  };

  return provider;
}

describe('ProviderRegistry: which backend is active', () => {
  it('makes the first registered provider active', () => {
    const registry = new ProviderRegistry();
    const claude = fakeProvider('claude-code');
    registry.register(claude);

    expect(registry.activeProviderId).toBe('claude-code');
    expect(registry.active()).toBe(claude);
    expect(registry.tryActive()).toBe(claude);
  });

  it('does not displace the active provider when a second one registers', () => {
    const registry = new ProviderRegistry();
    const claude = fakeProvider('claude-code');
    registry.register(claude);
    registry.register(fakeProvider('openrouter'));

    // Registration is additive. Activating a provider is a deliberate act, not a
    // side effect of wiring one up.
    expect(registry.active()).toBe(claude);
    expect(registry.list()).toHaveLength(2);
  });

  it('throws rather than degrading when nothing is registered', () => {
    const registry = new ProviderRegistry();

    // A missing provider is a wiring fault, not a user-facing condition, so it
    // must be loud. `tryActive()` is the soft variant for callers that need one.
    expect(() => registry.active()).toThrow(/wiring fault/);
    expect(registry.tryActive()).toBeNull();
    expect(registry.activeProviderId).toBeNull();
  });

  it('switches providers on select() and announces the change', () => {
    const registry = new ProviderRegistry();
    const claude = fakeProvider('claude-code');
    const openrouter = fakeProvider('openrouter');
    registry.register(claude);
    registry.register(openrouter);

    const announced: ProviderId[] = [];
    registry.onDidChangeActive((provider) => announced.push(provider.id));

    expect(registry.select('openrouter')).toBe(true);
    expect(registry.active()).toBe(openrouter);
    expect(announced).toEqual(['openrouter']);
  });

  it('refuses to select an unregistered provider, leaving the active one alone', () => {
    const registry = new ProviderRegistry();
    const claude = fakeProvider('claude-code');
    registry.register(claude);

    const announced: ProviderId[] = [];
    registry.onDidChangeActive((provider) => announced.push(provider.id));

    expect(registry.select('openrouter')).toBe(false);
    expect(registry.active()).toBe(claude);
    expect(announced).toEqual([]);
  });

  it('treats selecting the already-active provider as a successful no-op', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('claude-code'));

    const announced: ProviderId[] = [];
    registry.onDidChangeActive((provider) => announced.push(provider.id));

    expect(registry.select('claude-code')).toBe(true);
    // No transition happened, so nothing should be announced — a spurious
    // "provider changed" would rebuild the panel's status for no reason.
    expect(announced).toEqual([]);
  });

  it('publishes the incoming provider status on select()', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('claude-code'));
    registry.register(fakeProvider('openrouter', { message: 'OpenRouter connected' }));

    const seen: string[] = [];
    registry.onDidChangeStatus((status) => seen.push(status.message));

    registry.select('openrouter');

    // Otherwise the header would keep showing the previous provider's status
    // until something else happened to refresh it.
    expect(seen).toEqual(['OpenRouter connected']);
  });
});

describe('ProviderRegistry: status plumbing', () => {
  it('forwards only the active provider status changes', () => {
    const registry = new ProviderRegistry();
    const claude = fakeProvider('claude-code');
    const openrouter = fakeProvider('openrouter');
    registry.register(claude);
    registry.register(openrouter);

    const seen: string[] = [];
    registry.onDidChangeStatus((status) => seen.push(status.message));

    // A background provider must not make the UI flicker.
    openrouter.emitStatus({ message: 'openrouter background noise' });
    expect(seen).toEqual([]);

    claude.emitStatus({ message: 'Claude Code 2.0.1 detected' });
    expect(seen).toEqual(['Claude Code 2.0.1 detected']);
  });

  it('stops forwarding once the listener is disposed', () => {
    const registry = new ProviderRegistry();
    const claude = fakeProvider('claude-code');
    registry.register(claude);

    const seen: string[] = [];
    const subscription = registry.onDidChangeStatus((status) => seen.push(status.message));
    claude.emitStatus({ message: 'first' });
    subscription.dispose();
    claude.emitStatus({ message: 'second' });

    expect(seen).toEqual(['first']);
  });

  it('answers isActiveAvailable() from the active provider', () => {
    const registry = new ProviderRegistry();
    const claude = fakeProvider('claude-code');
    registry.register(claude);
    expect(registry.isActiveAvailable()).toBe(true);

    claude.emitStatus({ available: false, message: 'not found' });
    expect(registry.isActiveAvailable()).toBe(false);
  });

  it('reports unavailable, not available, when no provider is registered', () => {
    const registry = new ProviderRegistry();
    expect(registry.isActiveAvailable()).toBe(false);
  });

  it('describes the no-provider case instead of pretending', () => {
    const registry = new ProviderRegistry();
    const status = registry.activeRuntimeStatus();

    expect(status.available).toBe(false);
    expect(status.message).toMatch(/no ai provider/i);
    expect(status.pending).toBe(false);
  });

  it('detaches from every provider on dispose()', () => {
    const registry = new ProviderRegistry();
    const claude = fakeProvider('claude-code');
    registry.register(claude);

    const seen: string[] = [];
    registry.onDidChangeStatus((status) => seen.push(status.message));
    registry.dispose();

    claude.emitStatus({ message: 'after dispose' });

    expect(seen).toEqual([]);
    expect(registry.activeProviderId).toBeNull();
    expect(registry.list()).toEqual([]);
  });
});

describe('toRuntimeStatus: the panel contract', () => {
  it('carries through everything the provider reported', () => {
    const mapped = toRuntimeStatus({
      id: 'claude-code',
      label: 'Claude Code',
      available: true,
      message: 'Claude Code 2.0.1 detected.',
      version: '2.0.1',
      executablePath: '/usr/local/bin/claude',
    });

    expect(mapped).toEqual({
      available: true,
      message: 'Claude Code 2.0.1 detected.',
      version: '2.0.1',
      executablePath: '/usr/local/bin/claude',
    });
  });

  it('omits fields the provider did not report, rather than emptying them', () => {
    const mapped = toRuntimeStatus({
      id: 'claude-code',
      label: 'Claude Code',
      available: true,
      message: 'Claude Code detected (version could not be determined).',
    });

    // `version: ''` would render as a version. Absence is the honest encoding,
    // and the UI already treats these as optional.
    expect('version' in mapped).toBe(false);
    expect('executablePath' in mapped).toBe(false);
    expect('pending' in mapped).toBe(false);
    expect(mapped.message).toContain('version could not be determined');
  });

  it('preserves an explicit pending flag of false', () => {
    const mapped = toRuntimeStatus({
      id: 'claude-code',
      label: 'Claude Code',
      available: false,
      message: 'Runtime detection has not run yet.',
      pending: false,
    });

    expect(mapped.pending).toBe(false);
  });
});
