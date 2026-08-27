// Runs every suite in this directory and exits non-zero if any failed.
//
//   npm test
//
// api.test.mjs and shared-code.test.mjs need nothing but Node. The browser
// suites need Playwright and a Chromium; if either is missing they are
// reported as skipped rather than failed, so `npm test` still does something
// useful on a machine that has not set the browser up.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const SUITES = [
  { file: 'api.test.mjs', browser: false },
  { file: 'shared-code.test.mjs', browser: false },
  { file: 'child-apps.test.mjs', browser: true },
  { file: 'practice-sets.test.mjs', browser: true },
  { file: 'spot-the-spelling.test.mjs', browser: true },
  { file: 'missing-letters.test.mjs', browser: true },
  { file: 'apostrophes.test.mjs', browser: true },
  { file: 'parent-dashboard.test.mjs', browser: true },
  { file: 'setup-wizard.test.mjs', browser: true },
  { file: 'today-hub.test.mjs', browser: true },
  { file: 'plan-panel.test.mjs', browser: true },
];

const haveBrowser = await canLaunchBrowser();
if (!haveBrowser) {
  console.log(
    '\nSkipping the browser suites: no Chromium available.\n' +
    'Run `npx playwright install chromium`, or set PLAYWRIGHT_CHROMIUM_PATH\n' +
    'to an existing binary, to run them.\n'
  );
}

const failed = [];
const skipped = [];

for (const suite of SUITES) {
  if (suite.browser && !haveBrowser) { skipped.push(suite.file); continue; }
  console.log('\n══ ' + suite.file + ' ' + '═'.repeat(Math.max(0, 60 - suite.file.length)));
  const code = await run(suite.file);
  if (code !== 0) failed.push(suite.file);
}

console.log('\n' + '─'.repeat(64));
console.log(`ran ${SUITES.length - skipped.length} suite(s)` +
  (skipped.length ? `, skipped ${skipped.length}` : '') +
  (failed.length ? `, FAILED: ${failed.join(', ')}` : ', all passed'));
process.exit(failed.length ? 1 : 0);

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HERE + file], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function canLaunchBrowser() {
  try {
    const { chromium } = await import('playwright');
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
