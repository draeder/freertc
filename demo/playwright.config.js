import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/*.e2e.js'],
  timeout: 120_000,
  expect: {
    timeout: 90_000,
  },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
