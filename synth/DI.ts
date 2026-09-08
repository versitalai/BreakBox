// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Used throughout synth/ and editor/ for service resolution.
// Provides a minimal dependency-injection container so that implementations
// can be swapped without modifying every call site. No external dependencies.

/**
 * A minimal DI token type. Using `symbol` (preferred) or `string` as keys
 * avoids naming collisions and is tree-shakeable.
 */
export type ServiceToken = symbol | string;

/**
 * Minimal inversion-of-control container.
 *
 * This is intentionally simple — a plain Map under the hood — because the
 * project's build pipeline (rollup + terser) benefits from zero extra deps.
 * The goal is testability and swapability, not a full DI framework.
 *
 * Usage:
 *   // Register
 *   di.register(I_AUDIO_ENGINE, WorkletSynthAdapter);
 *
 *   // Resolve (at point of use, not constructor)
 *   const engine = di.resolve(I_AUDIO_ENGINE);
 *
 *   // In tests
 *   di.register(I_AUDIO_ENGINE, FakeSynthAdapter);
 */
export class DIContainer {
    private services: Map<ServiceToken, any> = new Map();

    /**
     * Register a service implementation. If `singleton` is true (default),
     * the same instance is returned on every resolve call.
     */
    register<T>(token: ServiceToken, impl: T, singleton: boolean = true): void {
        if (singleton && typeof impl === 'function') {
            // It's a constructor — we'll instantiate lazily
            this.services.set(token, { _factory: impl as any, _instance: undefined, _singleton: true });
        } else if (singleton) {
            // It's an instance — cache directly
            this.services.set(token, { _factory: null, _instance: impl, _singleton: true });
        } else {
            // Non-singleton: always call the factory
            this.services.set(token, { _factory: impl as any, _instance: undefined, _singleton: false });
        }
    }

    /**
     * Resolve a service by token. For constructors, instantiates (if singleton)
     * or creates a new instance each time (if non-singleton).
     */
    resolve<T>(token: ServiceToken): T {
        const entry = this.services.get(token);
        if (entry === undefined) {
            throw new Error(`DI: No service registered for token: ${String(token)}`);
        }
        if (entry._instance !== undefined) {
            return entry._instance as T;
        }
        if (entry._factory) {
            const instance = new entry._factory();
            if (entry._singleton) {
                entry._instance = instance;
            }
            return instance as T;
        }
        // Should not reach here
        throw new Error(`DI: Service registered but no factory or instance: ${String(token)}`);
    }

    /**
     * Check if a service is registered.
     */
    has(token: ServiceToken): boolean {
        return this.services.has(token);
    }

    /**
     * Reset all registrations. Useful in tests.
     */
    reset(): void {
        this.services.clear();
    }
}

/**
 * Global DI container instance.
 *
 * This is the single shared container used across BreakBox. Modules can
 * register services at import time (via side-effect registration) or
 * explicitly during application startup.
 *
 * For test isolation, use `di.reset()` between test runs.
 */
export const di: DIContainer = new DIContainer();

/**
 * Well-known service tokens used across BreakBox.
 *
 * These are declared as exported `symbol` constants so any module can
 * register or resolve a service by token without importing the implementation.
 *
 * To add a new service:
 *   1. Declare its token here: `export const I_MY_SERVICE: ServiceToken = Symbol('I_MY_SERVICE');`
 *   2. Register an implementation at startup (e.g., in the barrel or app entry)
 *   3. Resolve it anywhere via `di.resolve(I_MY_SERVICE)`
 */
export const I_AUDIO_ENGINE: ServiceToken = Symbol('I_AUDIO_ENGINE');
export const I_ENVIRONMENT: ServiceToken = Symbol('I_ENVIRONMENT');
