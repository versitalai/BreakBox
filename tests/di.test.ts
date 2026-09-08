// Regression test: DI container and Environment provider.
//
// Verifies the dependency injection system works correctly for service
// registration, resolution, and fallback behavior.

import { di, I_AUDIO_ENGINE } from '../synth/DI';
import { env, setEnvironment, getEnvironment } from '../synth/Environment';

describe('DI Container', () => {
    afterEach(() => {
        di.reset();
    });

    it('should register and resolve a service', () => {
        const mockEngine = { play: () => true };
        di.register(I_AUDIO_ENGINE, mockEngine, true);
        expect(di.has(I_AUDIO_ENGINE)).toBe(true);
        expect(di.resolve(I_AUDIO_ENGINE)).toBe(mockEngine);
    });

    it('should return false for unregistered tokens', () => {
        expect(di.has(I_AUDIO_ENGINE)).toBe(false);
    });

    it('should use fallback when token is not registered', () => {
        const fallback = { play: () => false };
        const result = di.resolveWithFallback(I_AUDIO_ENGINE, fallback);
        expect(result).toBe(fallback);
    });

    it('should throw when resolving unregistered token without fallback', () => {
        expect(() => di.resolve(I_AUDIO_ENGINE)).toThrow('No service registered');
    });

    it('should support transient (non-singleton) resolution', () => {
        class TestEngine {
            id = Math.random();
        }
        di.register(I_AUDIO_ENGINE, TestEngine, false);
        const a = di.resolve(I_AUDIO_ENGINE) as any;
        const b = di.resolve(I_AUDIO_ENGINE) as any;
        // Different instances for transient
        expect(a).not.toBe(b);
    });

    it('should return same instance for singleton', () => {
        class TestEngine {
            id = Math.random();
        }
        di.register(I_AUDIO_ENGINE, TestEngine, true);
        const a = di.resolve(I_AUDIO_ENGINE) as any;
        const b = di.resolve(I_AUDIO_ENGINE) as any;
        expect(a).toBe(b);
    });
});

describe('Environment Provider', () => {
    it('should expose env properties', () => {
        expect(env).toBeDefined();
    });

    it('should allow environment injection for testing', () => {
        const mockEnv = {
            isOffline: true,
            userAgent: 'test-agent',
            platform: 'test-platform',
            baseURI: 'http://test',
            locationHash: '#test',
            sessionStorage: null,
            localStorage: null,
            history: null,
            navigator: null,
            window: null,
            document: null,
        };
        const old = setEnvironment(mockEnv);
        expect(getEnvironment()).toBe(mockEnv);
        expect(env.isOffline).toBe(true);
        expect(env.userAgent).toBe('test-agent');
        // Restore
        setEnvironment(old);
    });
});
