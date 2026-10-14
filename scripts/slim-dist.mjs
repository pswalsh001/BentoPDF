// Post-build step for a personal, English-only build: removes the translated
// page trees, non-English locale files and pre-compressed copies from dist/.
// Run after `npm run build`. No PDF tool is removed.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.resolve(__dirname, '../dist');
const LOCALES_DIR = path.resolve(__dirname, '../public/locales');
const KEEP_LANGUAGE = 'en';

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function removeCompressedCopies(dir) {
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += removeCompressedCopies(full);
      continue;
    }
    // Only delete a .br/.gz file when the file it was compressed from is
    // still there, so engine data shipped only in compressed form survives.
    const match = entry.name.match(/^(.+)\.(br|gz)$/);
    if (match && fs.existsSync(path.join(dir, match[1]))) {
      fs.rmSync(full);
      removed++;
    }
  }
  return removed;
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('dist directory does not exist. Run the build first.');
  process.exit(1);
}

const toMb = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;
const before = dirSize(DIST_DIR);

const otherLanguages = fs
  .readdirSync(LOCALES_DIR)
  .filter((name) => fs.statSync(path.join(LOCALES_DIR, name)).isDirectory())
  .filter((name) => name !== KEEP_LANGUAGE);

for (const lang of otherLanguages) {
  fs.rmSync(path.join(DIST_DIR, lang), { recursive: true, force: true });
  fs.rmSync(path.join(DIST_DIR, 'locales', lang), {
    recursive: true,
    force: true,
  });
}

const removedCopies = removeCompressedCopies(DIST_DIR);
const after = dirSize(DIST_DIR);

console.log(`Removed ${otherLanguages.length} translated page trees`);
console.log(`Removed ${removedCopies} pre-compressed copies`);
console.log(`dist: ${toMb(before)} -> ${toMb(after)}`);
