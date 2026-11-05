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
const webPort = Number(process.env.PHOGAEM_TEST_WEB_PORT ?? 5174);
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) throw new Error('Invalid local test web port.');
const webBase = `http://localhost:${webPort}/phogaem/`;

export default defineConfig({
  testDir: './tests',
  testMatch: 'shared.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: webBase,
    viewport: { width: 1440, height: 1000 },
    launchOptions: existsSync(localChrome) ? { executablePath: localChrome } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${webPort}`,
    url: webBase,
    reuseExistingServer: false,
    env: { VITE_MLHOPS_API_BASE: process.env.PHOGAEM_INTEGRATION_API_BASE },
    timeout: 30_000,
  },
});
