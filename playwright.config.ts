import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: './tests',
  testMatch: 'album.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173/phogaem/',
    viewport: { width: 1440, height: 1000 },
    launchOptions: existsSync(localChrome) ? { executablePath: localChrome } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/phogaem/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
