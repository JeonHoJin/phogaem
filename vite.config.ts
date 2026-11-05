import { defineConfig, loadEnv } from 'vite';
import { DEFAULT_API_BASE, validateApiBase } from './apps/web/src/server/config.ts';

export default defineConfig(({ mode }) => ({
  root: 'apps/web',
  base: '/phogaem/',
  build: { outDir: '../../dist', emptyOutDir: true },
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
            content: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' ${api}; base-uri 'none'; object-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'`,
          },
          injectTo: 'head-prepend',
        }];
      },
    },
  }],
}));
