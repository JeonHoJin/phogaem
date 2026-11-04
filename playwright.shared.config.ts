import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

if (!process.env.PHOGAEM_INTEGRATION_API_BASE || !process.env.PHOGAEM_INTEGRATION_ADMIN_BASE) {
  throw new Error('Run python3 scripts/dev-mlhops.py --test to start an isolated integration stack.');
}

const admin = new URL(process.env.PHOGAEM_INTEGRATION_ADMIN_BASE);
if (admin.protocol !== 'http:' || admin.hostname !== '127.0.0.1') {
  throw new Error('Integration approval requests must target an isolated loopback admin listener.');
}

const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: './tests',
  testMatch: 'shared.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: 'http://localhost:5174/phogaem/',
    viewport: { width: 1440, height: 1000 },
    launchOptions: existsSync(localChrome) ? { executablePath: localChrome } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5174',
    url: 'http://localhost:5174/phogaem/',
    reuseExistingServer: false,
    env: { VITE_MLHOPS_API_BASE: process.env.PHOGAEM_INTEGRATION_API_BASE },
    timeout: 30_000,
  },
});
