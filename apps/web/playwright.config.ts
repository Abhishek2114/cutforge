import { defineConfig } from '@playwright/test'

// BASE_URL=https://abhishek2114.github.io/cutforge/ tests the live site; otherwise a local production build.
const live = process.env.BASE_URL

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  reporter: [['list']],
  use: {
    baseURL: live ?? 'http://localhost:4173/',
    channel: process.env.PW_CHANNEL, // "chrome" = installed Google Chrome (has the MP4 encoder)
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: live
    ? undefined
    : { command: 'npm run build && npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173/', reuseExistingServer: true },
})
