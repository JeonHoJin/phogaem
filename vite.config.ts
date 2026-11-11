import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_API_BASE, validateApiBase } from './apps/web/src/server/config.ts';

export default defineConfig(({ mode }) => ({
  root: 'apps/web',
  base: '/phogaem/',
  build: {
    outDir: '../../dist', emptyOutDir: true,
    rolldownOptions: {
      input: { app: fileURLToPath(new URL('./apps/web/index.html', import.meta.url)), sw: fileURLToPath(new URL('./apps/web/src/sw.ts', import.meta.url)) },
      output: { entryFileNames: chunk => chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js' },
    },
  },
  server: { port: 5173, strictPort: true },
  plugins: [{
    name: 'production-security-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler() {
        const env = loadEnv(mode, process.cwd(), 'VITE_');
        const api = validateApiBase(env.VITE_MLHOPS_API_BASE || DEFAULT_API_BASE);
        return [{
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src blob:; connect-src 'self' ${api}; base-uri 'none'; object-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'self'; manifest-src 'self'`,
          },
          injectTo: 'head-prepend',
        }];
      },
    },
  }],
}));
