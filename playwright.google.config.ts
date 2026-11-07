import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: ['google.spec.ts'],
  use: { ...base.use, baseURL: 'http://127.0.0.1:5174/phogaem/' },
  webServer: {
    command: 'npm run dev -- --port 5174',
    env: { VITE_GOOGLE_LOGIN_ENABLED: 'true' },
    url: 'http://127.0.0.1:5174/phogaem/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
