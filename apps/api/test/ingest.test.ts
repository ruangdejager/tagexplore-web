import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/index.js';
import { ingestRange } from '../src/ingest/ingest.js';
import { readSchedule } from '../src/ingest/farmrangerClient.js';

const ORG = 'org-a';
const DEVICE = '866049074634379';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../packages/core/test/fixtures/${name}.txt`, import.meta.url)),
    'utf8',
  );
}

/** Stands in for the logs API, which answers with an array of log-text chunks. */
function stubLogsApi(text: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify([{ logText: text }]), { status: 200 })),
  );
}

let dir: string;
let store: Store;
let config: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagexplore-ingest-'));
  store = new Store(join(dir, 'test.db'), 'nobody');
  store.createOrg(ORG, 'Org A');
  store.createDevice(DEVICE, ORG, 'Reader 379');
  config = loadConfig();
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const WHOLE_OF_JULY = { from: new Date('2026-07-01'), to: new Date('2026-08-01') };

describe('ingestRange', () => {
  it('stores a parsed round as one reading per tag', async () => {
    stubLogsApi(fixture('advancedMode'));
    const result = await ingestRange(store, config, DEVICE, WHOLE_OF_JULY.from, WHOLE_OF_JULY.to);

    expect(result.blocksParsed).toBe(1);
    expect(result.readingsWritten).toBe(4);

    store.addOrgTags(ORG, ['3E1E', '2F1F', '441F', '3D14']);
    const snapshots = store.tagSnapshots({
      orgId: ORG,
      from: Date.parse('2026-07-22T00:00:00+02:00'),
      to: Date.parse('2026-07-23T00:00:00+02:00'),
    });

    expect(snapshots.map((s) => s.tagId).sort()).toEqual(['2F1F', '3D14', '3E1E', '441F']);
    const withGps = snapshots.find((s) => s.tagId === '441F');
    expect(withGps?.lat).toBeCloseTo(-33.963701, 6);
    expect(withGps?.batteryMv).toBe(3678);
    expect(snapshots.find((s) => s.tagId === '3E1E')?.lat).toBeNull();
  });

  it('is idempotent — re-reading an overlapping window changes nothing', async () => {
    stubLogsApi(fixture('advancedMode'));
    await ingestRange(store, config, DEVICE, WHOLE_OF_JULY.from, WHOLE_OF_JULY.to);
    await ingestRange(store, config, DEVICE, WHOLE_OF_JULY.from, WHOLE_OF_JULY.to);

    store.addOrgTags(ORG, ['441F']);
    const [snapshot] = store.tagSnapshots({ orgId: ORG, from: 0, to: Date.now() });
    expect(snapshot?.readingCount).toBe(1);
  });

  it('folds a device’s timed-out attempt and its retry into one round', async () => {
    stubLogsApi(fixture('retryTimeoutA'));
    const result = await ingestRange(store, config, DEVICE, WHOLE_OF_JULY.from, WHOLE_OF_JULY.to);

    // Two blocks in the log — the LOG TIMEOUT and the successful retry six
    // seconds later — but one round, carrying the retry's full 18 tags.
    expect(result.blocksParsed).toBe(2);
    expect(result.readingsWritten).toBe(18);
  });

  it('records a round nobody could read as timed out rather than dropping it', async () => {
    stubLogsApi(fixture('fullTimeoutA'));
    const result = await ingestRange(store, config, DEVICE, WHOLE_OF_JULY.from, WHOLE_OF_JULY.to);
    expect(result.readingsWritten).toBe(0);
    // The device did report — it just failed — so its last known bracket must
    // not advance past a round we have no readings for.
    expect(store.latestBracketFor(DEVICE)).toBeNull();
  });

  it('surfaces an API failure instead of writing a half-empty window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    await expect(ingestRange(store, config, DEVICE, WHOLE_OF_JULY.from, WHOLE_OF_JULY.to)).rejects.toThrow(/503/);
  });
});

describe('readSchedule', () => {
  /** Trimmed to the fields that matter, from a real settings response. */
  const response = (overrides: Record<string, unknown> = {}): unknown => ({
    items: [
      {
        id: 5312,
        dailyReportType: 'MissedCall',
        dailyReportCountPerDay: 19,
        dailyReportStartTime: '04:10:00',
        dailyReportInterval: '01:00:00',
        timezoneAdjust: 7200,
        ...overrides,
      },
    ],
    metaData: { totalItemCount: 1 },
  });

  it('reads the daily report series off the settings payload', () => {
    expect(readSchedule(response())).toEqual({
      reportStartMinute: 250, // 04:10
      reportIntervalMinutes: 60,
      reportCountPerDay: 19,
    });
  });

  it('accepts a sub-hourly interval and a start time without seconds', () => {
    expect(readSchedule(response({ dailyReportStartTime: '06:35', dailyReportInterval: '00:30:00' }))).toEqual({
      reportStartMinute: 395,
      reportIntervalMinutes: 30,
      reportCountPerDay: 19,
    });
  });

  it('returns null rather than guessing when the payload has no usable schedule', () => {
    expect(readSchedule({ items: [] })).toBeNull();
    expect(readSchedule(response({ dailyReportStartTime: undefined }))).toBeNull();
    // A zero interval or a count below one is not a schedule anything can poll on.
    expect(readSchedule(response({ dailyReportInterval: '00:00:00' }))).toBeNull();
    expect(readSchedule(response({ dailyReportCountPerDay: 0 }))).toBeNull();
    expect(readSchedule(null)).toBeNull();
  });
});
