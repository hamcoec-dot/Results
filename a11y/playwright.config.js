// npm run a11y: axe (WCAG 2.1 A + AA) on the public pages at 320, 375 and 1280 px, plus the
// behaviour tests, in Chromium (--project chromium). npm run e2e:browsers runs the behaviour tests
// in Firefox, WebKit and on emulated Pixel 7 and iPhone 14 as well (plan: layer 8).
const { defineConfig, devices } = require('@playwright/test');

const PORT = 8124;
// The tests about what the pages do (not axe or screenshots, which are pinned to Chromium).
const BEHAVIOUR = /(dom-oracle|features|live-updates|resilience|xss)\.spec\.js$/;

const others = [
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
  { name: 'iphone-14', use: { ...devices['iPhone 14'] } },
].map((p) => ({ ...p, testMatch: BEHAVIOUR }));

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.js',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}/` },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    ...others,
  ],
  webServer: {
    command: `npx http-server .. -p ${PORT} -c-1 -a 127.0.0.1 -s`,
    cwd: __dirname,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
