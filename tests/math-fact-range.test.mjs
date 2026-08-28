// Multiplication stops at 10.
//
// Memorization in this house goes to the 10s, so the 11s and 12s are not a
// thing the app should ever put in front of a child — not in Practice, not in
// a Drill, and not as squares on the mastery map. Three separate places have
// to agree for that to hold: the generator, the grid config the map is drawn
// from, and the load-time prune that clears out facts a profile banked back
// when the range was wider. Miss any one of them and the 12s come back.
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const server = await serveRepo();
const BASE = server.url;
const { check, section, report } = createChecker();
const browser = await launchBrowser();

const FILE = 'math-star-v6_1.html';
const KEY = 'mathstar-ada';

// A profile banked in the old range: an 11 and a 12 fact in the review pool,
// one graduated, and grid squares for both — plus in-range neighbours that
// must survive untouched.
function legacyProfile() {
  return {
    childName: 'Ada', pin: '1234', gradeLevel: '4', showHistory: true, theme: 'classic',
    focusAreas: [{ id: 'f1', categories: ['multiplication-facts'], gradeBand: '2-4', name: 'Times tables' }],
    activeFocusId: 'f1',
    sessions: [],
    schedule: Array.from({ length: 7 }, () => ({ activity: 'none', practiceEnabled: true, drillEnabled: true })),
    reviewFacts: [
      { key: '7x12', category: 'multiplication-facts', prompt: '7 &times; 12 = ?', promptText: '7 × 12 = ?', answer: 84, type: 'numeric', streak: 1 },
      { key: '11x3', category: 'multiplication-facts', prompt: '11 &times; 3 = ?', promptText: '11 × 3 = ?', answer: 33, type: 'numeric', streak: 2 },
      { key: '7x8', category: 'multiplication-facts', prompt: '7 &times; 8 = ?', promptText: '7 × 8 = ?', answer: 56, type: 'numeric', streak: 1 },
    ],
    graduated: [
      { key: '12x12', category: 'multiplication-facts', prompt: '12 &times; 12 = ?', promptText: '12 × 12 = ?', answer: 144, type: 'numeric', sessionsAtGraduation: 1 },
      { key: '9x9', category: 'multiplication-facts', prompt: '9 &times; 9 = ?', promptText: '9 × 9 = ?', answer: 81, type: 'numeric', sessionsAtGraduation: 1 },
    ],
    masteryGrid: {
      'multiplication-facts::7-12': { attempts: 4, correct: 4, streak: 3 },
      'multiplication-facts::11-0': { attempts: 2, correct: 1, streak: 0 },
      'multiplication-facts::7-8': { attempts: 5, correct: 4, streak: 2 },
      'addition-facts::9-9': { attempts: 3, correct: 3, streak: 3 },
    },
  };
}

const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && isRealPageError(m.text())) errors.push('console: ' + m.text()); });

await page.addInitScript(([k, p]) => localStorage.setItem(k, JSON.stringify(p)), [KEY, legacyProfile()]);
await page.goto(`${BASE}/${FILE}`);
await page.waitForTimeout(500);

// --------------------------------------------------------------- generator ---
section('generated facts');
{
  // 2000 draws over a 121-fact space: an 11 or a 12 still in the generator
  // would show up hundreds of times, so a clean run is not luck.
  const drawn = await page.evaluate(() => {
    const seen = [];
    for (let i = 0; i < 2000; i++) {
      const p = genMultiplicationFacts();
      seen.push(p.key.split('x').map(Number));
    }
    return seen;
  });
  const over = drawn.filter(([a, b]) => a > 10 || b > 10);
  check('no operand above 10 in 2000 draws', over.length === 0, over.slice(0, 5));
  check('the 10s themselves still appear', drawn.some(([a, b]) => a === 10 || b === 10));
  check('the answer is still the product', await page.evaluate(() => {
    for (let i = 0; i < 200; i++) { const p = genMultiplicationFacts(); const [a, b] = p.key.split('x').map(Number); if (p.answer !== a * b) return false; }
    return true;
  }));
}

// -------------------------------------------------------------- grid config ---
section('mastery map');
{
  const cfg = await page.evaluate(() => GRID_CATS['multiplication-facts']);
  check('grid range is 0–10', cfg.min === 0 && cfg.max === 10, cfg);

  const html = await page.evaluate(() => renderGridHtml('multiplication-facts'));
  const headers = [...html.matchAll(/mg-cell mg-head">(\d+)</g)].map((m) => Number(m[1]));
  check('map has no 11 or 12 header', !headers.includes(11) && !headers.includes(12), headers);
  check('map still runs out to 10', headers.includes(10), headers);
  // 11 columns plus the corner, on 11 rows plus the header row.
  check('map is 11×11', (html.match(/class="mg-row"/g) || []).length === 12, (html.match(/class="mg-row"/g) || []).length);

  const div = await page.evaluate(() => GRID_CATS['division-facts']);
  check('division facts left alone', div.min === 2 && div.max === 12, div);
}

// ------------------------------------------------------------ banked facts ---
section('facts banked under the old range');
{
  const d = await page.evaluate(() => data);
  const reviewKeys = d.reviewFacts.map((r) => r.key);
  check('12s pruned from the review pool', !reviewKeys.includes('7x12'), reviewKeys);
  check('11s pruned from the review pool', !reviewKeys.includes('11x3'), reviewKeys);
  check('in-range review fact kept, streak intact', d.reviewFacts.some((r) => r.key === '7x8' && r.streak === 1), d.reviewFacts);

  const gradKeys = d.graduated.map((g) => g.key);
  check('12s pruned from graduated', !gradKeys.includes('12x12'), gradKeys);
  check('in-range graduated fact kept', gradKeys.includes('9x9'), gradKeys);

  const grid = Object.keys(d.masteryGrid);
  check('out-of-range squares cleared', !grid.includes('multiplication-facts::7-12') && !grid.includes('multiplication-facts::11-0'), grid);
  check('in-range square kept with its streak', d.masteryGrid['multiplication-facts::7-8'] && d.masteryGrid['multiplication-facts::7-8'].streak === 2, d.masteryGrid['multiplication-facts::7-8']);
  check('another category untouched', !!d.masteryGrid['addition-facts::9-9'], grid);
}

section('page health');
check('no page errors', errors.length === 0, errors);

await ctx.close();
await browser.close();
await server.close();
process.exit(report('math-fact-range') ? 1 : 0);
