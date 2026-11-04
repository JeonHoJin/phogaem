import { defineConfig } from 'vite';

export default defineConfig({
  root: 'apps/web',
  base: '/phogaem/',
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
