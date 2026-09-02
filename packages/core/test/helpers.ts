import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Reads one of the raw device-log fixtures under `test/fixtures/`. */
export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}.txt`, import.meta.url)), 'utf8');
}
