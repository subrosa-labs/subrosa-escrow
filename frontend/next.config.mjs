import { createRequire } from 'node:module';

/**
 * `tlock-js` is a Node-first library: age's armour encoding and drand's crypto both assume
 * Node built-ins. It is imported *lazily inside a client component*, so it never runs on
 * the server, but webpack still resolves it for the server graph at build time and would
 * fail on the missing built-ins. `buffer` has to be real — the armour encoding operates on
 * Buffers — while `crypto` must be `false` so the browser uses WebCrypto instead of a
 * polyfill (the polyfill is enormous and subtly different).
 *
 * `next.config.mjs` is ESM, so `require` does not exist here; `createRequire` is how the
 * Buffer shim gets resolved from this file.
 */
const require = createRequire(import.meta.url);

let bufferShim;
try {
  bufferShim = require.resolve('buffer/');
} catch {
  bufferShim = false;
}

// `webpack` is not a direct dependency; Next re-exports the build it uses. Importing the
// package by name would fail to resolve, which is the whole reason this indirection exists.
let ProvidePlugin = null;
try {
  ({ ProvidePlugin } = require('next/dist/compiled/webpack/webpack'));
} catch {
  ProvidePlugin = null;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: bufferShim,
        crypto: false,
        fs: false,
        stream: false,
        path: false,
      };

      // Some of the age code paths reference the `Buffer` global rather than importing it.
      // Without this they throw `Buffer is not defined` at the moment a user presses
      // "seal" — after the amount has been typed, which is the worst possible time.
      if (bufferShim && ProvidePlugin) {
        config.plugins.push(new ProvidePlugin({ Buffer: ['buffer', 'Buffer'] }));
      }
    }
    return config;
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
