import { defineConfig } from 'vitest/config';

/**
 * Only the pure logic is unit-tested here — encodings, drand arithmetic, formatting.
 *
 * The React components are exercised by the backend's integration tests against a live
 * chain instead, because what can go wrong in them is a wrong contract call, not a wrong
 * render, and a jsdom test of a component that only calls `api.prepare` would assert
 * nothing worth knowing.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    reporters: 'default',
  },
});
