// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Used by synth/model.ts (startLoadingSample uses OFFLINE);
//   editor/core/EditorConfig.ts (isMobile); scripts/build (terser --define OFFLINE=false)
//
// Replaces the fragile `declare global { const OFFLINE: boolean }` pattern
// with a proper injectable interface. The global OFFLINE variable is still
// supported for backwards compatibility, but all new code should use `env`.

/**
 * Environment abstraction layer.
 *
 * This interface provides runtime/environment information that used to be
 * accessed via bare globals (`OFFLINE`, `navigator`, etc.). By going through
 * an interface, tests can inject mock environments without needing a browser
 * or global variable hacks.
 *
 * The default implementation reads from the existing globals to preserve
 * exact 1:1 behavior.
 */
export interface Environment {
    /** Whether the app is running in offline mode (Ultrabox offline template). */
    readonly isOffline: boolean;
    /** The browser user agent string. */
    readonly userAgent: string;
    /** The browser platform string. */
    readonly platform: string;
    /** The document's base URL, or the current location href. */
    readonly baseURI: string;
    /** Window location hash string. */
    readonly locationHash: string;
    /** Window session storage. */
    readonly sessionStorage: Storage | null;
    /** Window local storage. */
    readonly localStorage: Storage | null;
    /** Window history object. */
    readonly history: History | null;
    /** Navigator object. */
    readonly navigator: Navigator | null;
    /** Window object (for event listeners, etc.). */
    readonly window: Window | null;
    /** Document object. */
    readonly document: Document | null;
}

/**
 * Default environment implementation.
 *
 * Reads from existing globals to preserve exact behavior. The `OFFLINE`
 * global is still read (set by terser --define or the HTML page) but through
 * this interface so it can be mocked in tests.
 */
class DefaultEnvironment implements Environment {
    get isOffline(): boolean {
        // Preserve exact behavior: read the global OFFLINE variable.
        // In the terser build this is inlined as `false`.
        // In a vm sandbox for tests, this checks for the variable.
        try {
            return (typeof (globalThis as any).OFFLINE !== 'undefined') ? !!(globalThis as any).OFFLINE : false;
        } catch {
            return false;
        }
    }
    get userAgent(): string { return navigator.userAgent; }
    get platform(): string { return navigator.platform; }
    get baseURI(): string { return document.baseURI || location.href; }
    get locationHash(): string { return window.location.hash; }
    get sessionStorage(): Storage | null { return window.sessionStorage; }
    get localStorage(): Storage | null { return window.localStorage; }
    get history(): History | null { return window.history; }
    get navigator(): Navigator | null { return navigator; }
    get window(): Window | null { return window; }
    get document(): Document | null { return document; }
}

/**
 * The global environment instance.
 *
 * In production, this is the DefaultEnvironment reading from browser globals.
 * In tests, call `setEnvironment(mockEnv)` to inject a custom environment.
 */
let currentEnvironment: Environment = new DefaultEnvironment();

/**
 * Replace the current environment. Used in tests to inject mock environments.
 *
 * @param env The environment to use.
 */
export function setEnvironment(env: Environment): Environment {
    const old = currentEnvironment;
    currentEnvironment = env;
    return old;
}

/**
 * Get the current environment.
 *
 * All code that previously accessed `OFFLINE`, `navigator`, etc. directly
 * should use this function instead.
 */
export function getEnvironment(): Environment {
    return currentEnvironment;
}

/**
 * Convenience reference to the current environment.
 *
 * Usage:
 *   import { env } from './Environment';
 *   if (env.isOffline) { ... }
 */
export const env: any = new Proxy({} as Environment, {
    get(_target: object, prop: string | symbol): any {
        return (currentEnvironment as any)[prop];
    },
});

// For backwards compatibility: the global OFFLINE variable is still declared
// in SynthConfig.ts's `declare global` block. The Environment interface
// in this file provides a mockable abstraction layer for new code.
// No additional global declaration needed here to avoid redeclaration conflicts.
