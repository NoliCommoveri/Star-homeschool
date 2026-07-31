// Shared plumbing for the suites in this directory.
//
// Deliberately dependency-light: assertions are a function and a counter, not
// a framework. The apps are self-contained HTML with no build step, and their
// tests should be readable in the same spirit — the point of these files is to
// pin down behaviour that is easy to break silently, not to introduce a
// testing stack the repo otherwise has no use for.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------- checks ----

export function createChecker() {
  const state = { failures: 0, total: 0 };

  function check(label, condition, detail) {
    state.total += 1;
    if (condition) {
      console.log('  ok   ' + label);
    } else {
      state.failures += 1;
      console.log('  FAIL ' + label + (detail !== undefined ? ' → ' + safeJson(detail) : ''));
    }
  }

  function section(name) { console.log('\n[' + name + ']'); }

  function report(suite) {
    const line = state.failures
      ? `\n${suite}: ${state.failures} FAILURE(S) of ${state.total}\n`
      : `\n${suite}: all ${state.total} checks passed.\n`;
    console.log(line);
    return state.failures;
  }

  return { check, section, report, state };
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

// ---------------------------------------------------------- static server ----

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.csv': 'text/csv',
};

// The apps are static files and the service worker only registers over http,
// so the browser suites need an origin rather than file://. One is started per
// run instead of asking whoever is running the tests to have a server going.
export async function serveRepo() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.includes('..')) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(join(REPO, path === '/' ? 'index.html' : path));
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// --------------------------------------------------------------- browser ----

// Normally Playwright finds the browser it installed (`npx playwright install
// chromium`). PLAYWRIGHT_CHROMIUM_PATH is an escape hatch for environments
// that ship a Chromium of a different build number than this Playwright
// expects, where the download would be redundant or blocked.
export async function launchBrowser() {
  const { chromium } = await import('playwright');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
  try {
    return await chromium.launch(executablePath ? { executablePath } : {});
  } catch (err) {
    if (/Executable doesn't exist/.test(String(err))) {
      console.error(
        '\nNo Chromium available. Either run `npx playwright install chromium`,\n' +
        'or point PLAYWRIGHT_CHROMIUM_PATH at an existing binary.\n'
      );
    }
    throw err;
  }
}

// The browser asks for /favicon.ico on every page and none of these pages
// declares one, so that 404 is constant background noise rather than a signal.
export const isRealPageError = (text) => !/Failed to load resource/.test(text);
