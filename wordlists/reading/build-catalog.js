// Converts the reading quiz source CSVs into reading-catalog.json (repo
// root), per docs/reading-star-spec.md §4/§4.1/§4.2.
//
// Usage:
//   node wordlists/reading/build-catalog.js
//
// Reads every *_Quiz_*.csv in this directory, validates book_key/genre, and
// writes ../../reading-catalog.json. Re-run whenever a CSV changes or a new
// one is added — it is idempotent: question ids are matched by exact question
// text against the existing reading-catalog.json (if present) before minting
// new ones, so regenerating the catalog never renumbers a question already in
// use by a recorded `payload.missed` (§4.1's stability argument, applied to
// question ids).
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const OUT_PATH = path.join(DIR, "..", "..", "reading-catalog.json");

// The controlled genre vocabulary (§4.2). A placeholder, not a considered
// taxonomy — adding a value is free; renaming or merging one after books have
// been classified against it is not, so a row's genre must be in this list or
// the build fails loudly rather than silently letting through a variant
// spelling ("sci-fi" vs "science-fiction").
const GENRE_VOCAB = [
  "adventure", "animal-fiction", "biography-nonfiction", "fantasy",
  "historical-fiction", "humor", "mystery", "realistic-fiction",
  "science-fiction", "poetry",
];

function fail(msg) {
  console.error("build-catalog: " + msg);
  process.exit(1);
}

// Minimal CSV parser: handles quoted fields (with "" as an escaped quote) and
// commas inside quotes. No embedded-newline support needed — the source rows
// are one question per line.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.map((line) => {
    const cells = [];
    let cur = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else cur += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ",") { cells.push(cur); cur = ""; }
        else cur += c;
      }
    }
    cells.push(cur);
    return cells;
  });
}

function loadCSVRows(file) {
  const raw = fs.readFileSync(file, "utf8");
  const rows = parseCSV(raw);
  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] || "").trim(); });
    return row;
  });
}

// Existing catalog, if any — used to keep question ids stable across reruns.
let existing = {};
if (fs.existsSync(OUT_PATH)) {
  try { existing = JSON.parse(fs.readFileSync(OUT_PATH, "utf8")); }
  catch (e) { fail(`existing ${OUT_PATH} is not valid JSON, refusing to overwrite blind: ${e.message}`); }
}

const csvFiles = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".csv"));
if (csvFiles.length === 0) fail("no CSV files found in " + DIR);

const books = {}; // book_key -> { series, seriesKey, seriesNumber, title, author, gradeLevel, genre, questions: [] }
const bookMeta = {}; // book_key -> the fields that must be consistent across its rows, for the uniqueness check

for (const file of csvFiles) {
  const rows = loadCSVRows(path.join(DIR, file));
  rows.forEach((row, idx) => {
    const ctx = `${file}:${idx + 2}`; // +2: header row + 1-indexing
    const bookKey = row.book_key;
    if (!bookKey) fail(`${ctx}: blank book_key`);

    const meta = {
      title: row.book_title,
      author: row.author,
      seriesKey: row.series_key || null,
      series: row.series_name || null,
      seriesNumber: row.series_number ? Number(row.series_number) : null,
      gradeLevel: row.grade_level,
    };
    if (bookMeta[bookKey]) {
      const prev = bookMeta[bookKey];
      for (const field of Object.keys(meta)) {
        if (prev[field] !== meta[field]) {
          fail(`${ctx}: book_key "${bookKey}" has inconsistent ${field} ("${prev[field]}" vs "${meta[field]}") across its rows`);
        }
      }
    } else {
      bookMeta[bookKey] = meta;
      books[bookKey] = { ...meta, genre: [], questions: [] };
    }

    const genreValues = (row.genre || "").split(";").map((g) => g.trim()).filter(Boolean);
    for (const g of genreValues) {
      if (!GENRE_VOCAB.includes(g)) {
        fail(`${ctx}: genre "${g}" is not in the controlled vocabulary (${GENRE_VOCAB.join(", ")})`);
      }
    }
    if (genreValues.length && books[bookKey].genre.length === 0) books[bookKey].genre = genreValues;

    if (!row.question || !row.correct_answer) fail(`${ctx}: missing question or correct_answer`);
    const wrong = [row.wrong_answer_1, row.wrong_answer_2, row.wrong_answer_3].filter(Boolean);
    if (wrong.length !== 3) fail(`${ctx}: expected exactly 3 wrong answers, got ${wrong.length}`);

    books[bookKey].questions.push({ q: row.question, correct: row.correct_answer, wrong });
  });
}

// Assign stable ids: reuse an existing id for a question with identical text
// under the same book_key; mint the smallest unused number otherwise.
for (const [bookKey, book] of Object.entries(books)) {
  const prevQuestions = (existing[bookKey] && existing[bookKey].questions) || [];
  const idByText = {};
  const usedNumbers = new Set();
  for (const pq of prevQuestions) {
    idByText[pq.q] = pq.id;
    const m = /-q(\d+)$/.exec(pq.id || "");
    if (m) usedNumbers.add(Number(m[1]));
  }
  let nextNumber = 1;
  function mintNumber() {
    while (usedNumbers.has(nextNumber)) nextNumber++;
    usedNumbers.add(nextNumber);
    return nextNumber;
  }
  book.questions = book.questions.map((q) => {
    const id = idByText[q.q] || `${bookKey}-q${mintNumber()}`;
    return { id, ...q };
  });
}

const out = {};
for (const [bookKey, book] of Object.entries(books)) {
  out[bookKey] = {
    series: book.series,
    seriesKey: book.seriesKey,
    seriesNumber: book.seriesNumber,
    title: book.title,
    author: book.author,
    gradeLevel: book.gradeLevel,
    genre: book.genre,
    questions: book.questions,
  };
}

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
const bookCount = Object.keys(out).length;
const qCount = Object.values(out).reduce((n, b) => n + b.questions.length, 0);
console.log(`Wrote ${OUT_PATH}: ${bookCount} books, ${qCount} questions.`);
