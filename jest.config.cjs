/**
 * Jest configuration for BreakBox tests.
 *
 * Tests use ts-jest to transform TypeScript source files.
 * Tests run in a Node.js environment with jsdom for DOM APIs.
 */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json', 'node'],
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            tsconfig: 'tsconfig.test.json',
        }],
    },
    moduleNameMapper: {
        // Mock browser-only modules that break Node.js tests
        '\\.(css|less|scss)$': 'identity-obj-proxy',
    },
    testTimeout: 30000,
    verbose: true,
};
