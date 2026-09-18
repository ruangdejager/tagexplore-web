/**
 * Tag IDs are at most 4 raw bytes, but the log parser strips any leading or
 * trailing non-printable byte — so a real, already-stored ID can be shorter
 * than 4 characters (e.g. `D1E` when the true 4-byte ID had a non-printable
 * lead byte). Validation therefore accepts 1-4 printable-ASCII characters, to
 * match what is actually stored rather than the nominal byte length.
 */
const TAG_ID_RE = /^[\x21-\x7E]{1,4}$/;

export function isValidTagId(value: string): boolean {
  return TAG_ID_RE.test(value.toUpperCase());
}

export interface TagIdListResult {
  /** Uppercased, de-duplicated, in the order first seen. */
  ids: string[];
  /** Tokens that did not look like tag IDs, echoed back for an error message. */
  invalid: string[];
}

/** Parses free text (whitespace- or comma-separated) into a validated tag ID list. */
export function parseTagIdList(input: string | string[] | null | undefined): TagIdListResult {
  const tokens = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/))
    .map((t) => String(t).trim())
    .filter(Boolean);

  const ids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const up = token.toUpperCase();
    if (!isValidTagId(up)) {
      invalid.push(token);
      continue;
    }
    if (seen.has(up)) continue;
    seen.add(up);
    ids.push(up);
  }
  return { ids, invalid };
}

/** Short label for an IMEI in a compact column, e.g. `866049074634379` → `379`. */
export function shortDeviceId(imei: string): string {
  return String(imei).slice(-3);
}

/**
 * Renders a LoRa device id the way the firmware's own `%X` log output does —
 * uppercase hex, unpadded, no `0x` prefix — so an id that arrives as an
 * integer (the push-ingest endpoint sends CBOR unsigned integers, not text)
 * lands on exactly the same string the log-scraping path already stores for
 * that tag. `43981` → `ABCD`, `15902` → `3E1E`.
 *
 * Returns null for anything that is not a uint32, since there is no sensible
 * tag id to render for it.
 */
export function formatTagId(value: number): string | null {
  if (!Number.isInteger(value) || value < 0 || value > 0xff_ff_ff_ff) return null;
  return value.toString(16).toUpperCase();
}
