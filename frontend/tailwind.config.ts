import type { Config } from 'tailwindcss';

/**
 * The palette is deliberately dark and low-saturation: this is a privacy tool, and the
 * one colour anything gets is the state of an envelope — sealed, open, settled.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#07090c',
          900: '#0c1015',
          850: '#11161d',
          800: '#171d26',
          700: '#232c38',
          600: '#35404f',
        },
        ash: {
          400: '#7c8798',
          300: '#9aa5b4',
          200: '#c3cad4',
          100: '#e6eaf0',
        },
        // "wax" — a sealed envelope, unbroken.
        wax: {
          500: '#c8443c',
          400: '#e0605a',
          300: '#f08b86',
        },
        // "reveal" — the round has landed, the envelope is open.
        reveal: {
          500: '#3f8f6f',
          400: '#54b088',
          300: '#7fd0ab',
        },
        amber2: '#d6a13a',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        seal: '0 0 0 1px rgba(200,68,60,0.35), 0 8px 24px -12px rgba(200,68,60,0.35)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};

export default config;
