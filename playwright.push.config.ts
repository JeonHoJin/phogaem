import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: ['push.spec.ts'],
  // Full Chromium includes browser push services absent from the minimal headless shell.
  use: { ...base.use, channel: 'chromium', baseURL: 'http://127.0.0.1:5176/phogaem/' },
  webServer: {
    command: 'npm run build -- --outDir ../../.local/push-dist && npm run preview -- --port 5176 --strictPort --outDir ../../.local/push-dist',
    env: { VITE_PHOGAEM_PUSH_ENABLED: 'true', VITE_GOOGLE_LOGIN_ENABLED: 'false', VITE_MLHOPS_API_BASE: 'http://127.0.0.1:5176' },
    url: 'http://127.0.0.1:5176/phogaem/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
