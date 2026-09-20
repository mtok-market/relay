import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Run only after every old writer is stopped. Markers cover a crash between
// the exclusive claim and its JSONL append; importing the log alone loses those.
export async function importRedemptionFiles(store, files) {
  let imported = 0;
  for (const file of files) {
    for (const [index, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      const state = record.state ?? 'complete';
      if (typeof record.k !== 'string' || !record.k || !Number.isFinite(Number(record.at))) {
        throw new Error(`malformed redemption record at ${file}:${index + 1}`);
      }
      await store.importRecord({ key: record.k, state, payload: record.payload });
      imported++;
    }
    const directory = `${file}.claims`;
    // Pre-marker relay versions have only the JSONL file.
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const text = fs.readFileSync(path.join(directory, name), 'utf8');
      const key = text.endsWith('\n') ? text.slice(0, -1) : text;
      if (!key || createHash('sha256').update(key).digest('hex') !== name) {
        throw new Error(`malformed redemption marker in ${directory}`);
      }
      await store.importRecord({ key, state: 'pending' });
      imported++;
    }
  }
  return imported;
}
