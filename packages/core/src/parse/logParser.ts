/**
 * Parses raw Farmranger unit log text into discovery blocks.
 *
 * Block header example:
 *   *00:00:29(+02:00) Mon 06-Jul-2026 4019mV
 *   ---------------------------------
 *   Tag Discovery (advanced):
 *   DeviceId,Hops,Wave,RSSI,BatMv,Move,Lat,Lon,FwPatch,RssiSrc
 *
 *   3E1E,1,1,-68,3637,1,0,0,22,0
 *   ...
 *
 * `RssiSrc` is newer still: the id of the tag this row's data actually
 * relayed through to reach the reader — "0" (or the column simply being
 * absent, on older firmware) means there was no link yet.
 *
 *   Total devices discovered: 11
 *   ---------------------------------
 *
 * The device self-describes its own column order via a CSV header line right
 * after "Tag Discovery (...):" — column order is NOT assumed to be fixed (it
 * has already changed between firmware versions), so it is read from that
 * header every time rather than hardcoded.
 *
 * Two known modes, each with a different field set:
 *   advanced: DeviceId,Hops,Wave,RSSI,BatMv,Move,Lat,Lon,FwPatch
 *   basic:    DeviceId,BatMv,RSSI,Move,FwPatch,Lat,Lon,AgeS
 * Older logs may have no mode label and no header line at all — those fall
 * back to the original known column order.
 *
 * A block may instead contain "LOG TIMEOUT" somewhere in its body, indicating
 * the device failed to log a discovery round.
 */

import { MONTHS, MONTH_NAMES } from '../time.js';
import type { DiscoveryBlock, TagReading } from '../types.js';

// Every timestamped log line starts with a "time mark":
//   dated: *21:11:04(+02:00) Thu 27-Aug-2026 4073mV HttpPost OK (1, 0|200, LTE|31)
//   bare:  *22:00:01(+02:00) gnss on (max-m10s)
// A mark is a *discovery anchor* only when nothing but whitespace follows it before
// the newline — that's what tells `*22:00:27(+02:00) ` (a discovery block header)
// apart from `*22:00:27(+02:00) frtag: session start` (an info line). Both kinds are
// collected here, because the info lines are what carry the calendar date on firmware
// that emits bare discovery anchors: v2.1.x drops to "minimal syslog mode" around a
// discovery round, so the anchor itself has no date and must inherit one from the
// dated lines around it (see resolveMarkDates).
const TIME_MARK_RE = /\*(\d{2}:\d{2}:\d{2})\(([+-]\d{2}:\d{2})\)(?:[ \t]+\w+[ \t]+(\d{2})-(\w{3})-(\d{4})[ \t]+(\d+)mV)?/g;
// Sticky: matched at the end of a time mark to test "only whitespace left on this line".
const LINE_END_RE = /[ \t]*(?=\r?\n)/y;
// Log lines are chronological, so a clock time that goes *backwards* means the day
// rolled over at midnight. Requiring a big backward step (rather than any decrease)
// keeps out-of-order jitter — repeated lines a few seconds apart, or the interleaving
// of two devices' text — from being mistaken for a new day. A real rollover always
// shows up as a step back of nearly a full day, since log lines are only minutes apart.
const ROLLOVER_BACKSTEP_SECONDS = 6 * 60 * 60;
// Captures the mode label (e.g. "advanced") and any trailing free text before the colon
// (e.g. " primary v2.0.1", which carries the reading device's own firmware version) —
// separately from the tag section body itself.
const TAG_SECTION_RE = /Tag Discovery(?:\s*\(([^)]*)\))?([^:\n]*):([\s\S]*?)Total devices discovered:/i;
const FW_VERSION_RE = /v?\d+(?:\.\d+){1,3}/i;

type TagField = keyof Omit<TagReading, 'hasGps'>;

/** Maps a normalized header column name to our internal field name. */
const COLUMN_ALIASES: Record<string, TagField> = {
  deviceid: 'id',
  hops: 'hops',
  wave: 'waveCount',
  rssi: 'rssi',
  batmv: 'battery',
  move: 'movementState',
  lat: 'lat',
  lon: 'lon',
  fwpatch: 'fwVersionPatch',
  ages: 'gpsAgeSeconds',
  rssisrc: 'linkId',
};

/** Fallback for logs predating the self-describing header line. */
const DEFAULT_HEADER = 'DeviceId,Hops,RSSI,BatMv,Wave,Move,Lat,Lon,FwPatch';

type ColumnMap = Partial<Record<TagField, number>>;

function normalizeColumnName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildColumnMap(headerLine: string): ColumnMap {
  const map: ColumnMap = {};
  headerLine.split(',').forEach((raw, index) => {
    const field = COLUMN_ALIASES[normalizeColumnName(raw)];
    if (field) map[field] = index;
  });
  return map;
}

function isHeaderLine(line: string): boolean {
  return normalizeColumnName(line.split(',')[0] ?? '') === 'deviceid';
}

function toIsoTimestamp(time: string, offset: string, day: string, monStr: string, year: string): string | null {
  const month = MONTHS[monStr];
  if (!month) return null;
  return `${year}-${month}-${day}T${time}${offset}`;
}

/**
 * Tag IDs are always 4 printable-ASCII characters, but occasionally arrive with
 * a stray non-printable control character stuck to one edge — strip those, not
 * interior characters.
 */
function sanitizeTagId(raw: string): string {
  const isPrintable = (ch: string): boolean => {
    const code = ch.charCodeAt(0);
    return code >= 32 && code <= 126;
  };
  let s = raw;
  while (s.length && !isPrintable(s[0] as string)) s = s.slice(1);
  while (s.length && !isPrintable(s[s.length - 1] as string)) s = s.slice(0, -1);
  return s;
}

function parseTagRow(rowParts: string[], columnMap: ColumnMap): TagReading | null {
  const field = (name: TagField): string | undefined => {
    const index = columnMap[name];
    if (index === undefined || index >= rowParts.length) return undefined;
    const value = rowParts[index];
    return value === '' ? undefined : value;
  };

  const id0 = field('id');
  const id = id0 === undefined ? undefined : sanitizeTagId(id0).toUpperCase();
  const battery = parseFloat(field('battery') ?? '');
  const rssi = parseFloat(field('rssi') ?? '');
  // Guards against stray non-tag rows (e.g. a header line the mode-detection above
  // missed) — every real tag row has an id plus valid battery/RSSI readings.
  if (!id || Number.isNaN(battery) || Number.isNaN(rssi)) return null;
  // A real tag ID is at most 4 hex chars. Longer IDs are the firmware's own
  // pseudo-devices, not tags — a FOTA transfer logs a one-row "discovery" per chunk
  // with an 8-char progress ID (F9000000, F9000004, ... F9F9F9F9). Dropping them here
  // keeps them out of counts, charts and the missing-tag list.
  if (id.length > 4) return null;

  const toIntOrNull = (name: TagField): number | null => {
    const raw = field(name);
    if (raw === undefined) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  };

  const latRaw = field('lat');
  const lonRaw = field('lon');
  const lat = latRaw !== undefined ? parseInt(latRaw, 10) : NaN;
  const lon = lonRaw !== undefined ? parseInt(lonRaw, 10) : NaN;
  const hasGps = !Number.isNaN(lat) && !Number.isNaN(lon) && !(lat === 0 && lon === 0);

  // "0" is the firmware's own "no link yet" value, same idea as (0,0) meaning
  // no fix for lat/lon above — not a real tag id, so it's normalized to null
  // right alongside the column being absent entirely.
  const linkRaw = field('linkId');
  const linkCleaned = linkRaw === undefined ? '' : sanitizeTagId(linkRaw).toUpperCase();
  const linkId = linkCleaned === '' || linkCleaned === '0' ? null : linkCleaned;

  return {
    id,
    hops: toIntOrNull('hops'),
    waveCount: toIntOrNull('waveCount'),
    rssi,
    battery,
    movementState: toIntOrNull('movementState'),
    // Coordinates arrive as fixed-point microdegrees.
    lat: hasGps ? lat / 1e6 : null,
    lon: hasGps ? lon / 1e6 : null,
    hasGps,
    fwVersionPatch: toIntOrNull('fwVersionPatch'),
    gpsAgeSeconds: toIntOrNull('gpsAgeSeconds'),
    linkId,
  };
}

function parseTagSection(sectionText: string): TagReading[] {
  const lines = sectionText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const first = lines[0] as string;
  const headerPresent = isHeaderLine(first);
  const columnMap = buildColumnMap(headerPresent ? first : DEFAULT_HEADER);
  const dataLines = headerPresent ? lines.slice(1) : lines;

  const tags: TagReading[] = [];
  for (const line of dataLines) {
    const tag = parseTagRow(line.split(',').map((p) => p.trim()), columnMap);
    if (tag) tags.push(tag);
  }
  return tags;
}

interface CalendarDate {
  day: string;
  monStr: string;
  year: string;
}

interface TimeMark {
  time: string;
  offset: string;
  day: string | undefined;
  monStr: string | undefined;
  year: string | undefined;
  invalidClock: boolean;
  batteryMv: number | null;
  isAnchor: boolean;
  /** Offset into the full text just past this mark — where its body starts. */
  bodyStart: number;
  index: number;
  date?: CalendarDate | null;
}

/**
 * Pulls every timestamped mark out of the log, flagging the ones that are
 * discovery anchors (nothing but whitespace after the timestamp) and capturing
 * the calendar date on the ones that carry it.
 */
function collectTimeMarks(fullText: string): TimeMark[] {
  const marks: TimeMark[] = [];
  for (const m of fullText.matchAll(TIME_MARK_RE)) {
    const [, time, offset, day, monStr, year, batteryMv] = m;
    const end = (m.index ?? 0) + m[0].length;
    LINE_END_RE.lastIndex = end;
    // A device that boots without a valid RTC logs the epoch date ("rtc invalid",
    // 01-Jan-1970) until it syncs. Those lines are no use as a date source and their
    // clock times are meaningless, so they're neither trusted nor carried forward.
    const invalidClock = Boolean(year) && Number(year) < 2000;
    marks.push({
      time: time as string,
      offset: offset as string,
      day: invalidClock ? undefined : day,
      monStr: invalidClock ? undefined : monStr,
      year: invalidClock ? undefined : year,
      invalidClock,
      batteryMv: batteryMv ? parseInt(batteryMv, 10) : null,
      isAnchor: LINE_END_RE.test(fullText),
      bodyStart: end,
      index: m.index ?? 0,
    });
  }
  return marks;
}

function timeToSeconds(time: string): number {
  const [h, m, s] = time.split(':').map(Number) as [number, number, number];
  return h * 3600 + m * 60 + s;
}

function shiftDate({ day, monStr, year }: CalendarDate, deltaDays: number): CalendarDate {
  const d = new Date(Date.UTC(Number(year), Number(MONTHS[monStr]) - 1, Number(day)));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return {
    day: String(d.getUTCDate()).padStart(2, '0'),
    monStr: MONTH_NAMES[d.getUTCMonth()] as string,
    year: String(d.getUTCFullYear()),
  };
}

/**
 * Gives every mark a calendar date and a unit battery reading, in place.
 *
 * Firmware >= v2.1.x logs the discovery anchor itself with no date (it enters
 * "minimal syslog mode" for the round), so a date has to come from the ordinary
 * log lines around it. Two passes:
 *   forward  — carry the last dated line's date onto the bare marks that follow it,
 *              advancing a day whenever the clock jumps backwards past midnight;
 *   backward — do the same in reverse for bare marks that appear *before* the first
 *              dated line in the fetched text, stepping a day back at each rollover.
 * The backward pass matters because a fetch window often starts mid-day: without it,
 * every discovery before the first dated line would be undatable and silently dropped.
 */
function resolveMarkDates(marks: TimeMark[]): void {
  let current: CalendarDate | null = null;
  let lastSeconds: number | null = null;
  let battery: number | null = null;
  for (const mark of marks) {
    if (mark.invalidClock) continue; // epoch-dated boot line: neither a date source nor a step
    const seconds = timeToSeconds(mark.time);
    if (mark.day) {
      current = { day: mark.day, monStr: mark.monStr as string, year: mark.year as string };
      battery = mark.batteryMv;
    } else if (current && lastSeconds !== null && lastSeconds - seconds > ROLLOVER_BACKSTEP_SECONDS) {
      current = shiftDate(current, 1);
    }
    mark.date = current;
    if (mark.batteryMv === null) mark.batteryMv = battery;
    lastSeconds = seconds;
  }

  let nextDate: CalendarDate | null = null;
  let nextSeconds = 0;
  let nextBattery: number | null = null;
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i] as TimeMark;
    if (mark.invalidClock) continue;
    const seconds = timeToSeconds(mark.time);
    if (mark.date) {
      nextDate = mark.date;
      nextSeconds = seconds;
      nextBattery = mark.batteryMv;
      continue;
    }
    if (!nextDate) continue; // no dated line anywhere after it either — undatable
    if (seconds - nextSeconds > ROLLOVER_BACKSTEP_SECONDS) nextDate = shiftDate(nextDate, -1);
    mark.date = nextDate;
    mark.batteryMv = nextBattery;
    nextSeconds = seconds;
  }
}

/** Parses all discovery blocks out of a single device's raw log text. */
export function parseLogText(fullText: string, unitId: string): DiscoveryBlock[] {
  const marks = collectTimeMarks(fullText);
  resolveMarkDates(marks);
  const anchors = marks.filter((m) => m.isAnchor);

  const blocks: DiscoveryBlock[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i] as TimeMark;
    // A block's body runs to the next anchor, so intervening info lines stay part of it.
    const bodyEnd = i + 1 < anchors.length ? (anchors[i + 1] as TimeMark).index : fullText.length;
    const body = fullText.slice(anchor.bodyStart, bodyEnd);

    if (anchor.invalidClock) continue; // logged while the device's RTC was unset
    if (!anchor.date) continue; // no dated log line anywhere in this fetch — can't date it

    const { day, monStr, year } = anchor.date;
    const timestamp = toIsoTimestamp(anchor.time, anchor.offset, day, monStr, year);
    if (!timestamp) continue;

    const base = {
      unitId,
      timestamp,
      date: `${day}-${monStr}-${year}`,
      time: anchor.time,
      unitBatteryMv: anchor.batteryMv,
    };

    if (/LOG TIMEOUT/i.test(body)) {
      blocks.push({ ...base, isTimeout: true, tags: [], total: 0, readerFwVersion: null });
      continue;
    }

    const totalMatch = body.match(/Total devices discovered:\s*(\d+)/i);
    const total = totalMatch ? parseInt(totalMatch[1] as string, 10) : 0;

    const tagSectionMatch = body.match(TAG_SECTION_RE);
    const tags = tagSectionMatch ? parseTagSection(tagSectionMatch[3] as string) : [];
    // e.g. "Tag Discovery (advanced) primary v2.0.1:" -> the reading device's own fw
    // version, distinct from each tag's own fwVersionPatch reported in the row data.
    const readerInfoText = tagSectionMatch ? (tagSectionMatch[2] ?? '') : '';
    const fwMatch = readerInfoText.match(FW_VERSION_RE);

    blocks.push({ ...base, isTimeout: false, tags, total, readerFwVersion: fwMatch ? fwMatch[0] : null });
  }

  return blocks;
}
