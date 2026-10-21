// npm run a11y: axe (WCAG 2.1 A + AA) on the public pages at 320, 375 and 1280 px.
const { defineConfig } = require('@playwright/test');

const PORT = 8124;

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.js',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}/`, browserName: 'chromium' },
  webServer: {
    command: `npx http-server .. -p ${PORT} -c-1 -a 127.0.0.1 -s`,
    cwd: __dirname,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
