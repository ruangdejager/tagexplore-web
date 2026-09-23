import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { Store, type ReadingInput, type RoundInput } from '../src/db/index.js';
import { inferDeviceIdentities, scoreCarriedTags, scoreRadioIdVotes } from '../src/infer/identity.js';

const ORG = 'org-a';
const DEVICE = '866049074634379';
const OTHER_DEVICE = '866049074634338';
const BRACKET_MS = 15 * 60_000;
const T0 = Date.parse('2026-07-22T04:10:00+02:00');

let dir: string;
let store: Store;
let config: Config;

function round(bracketAt: number, imei = DEVICE): RoundInput {
  return {
    bracketAt,
    deviceImei: imei,
    tagCount: 1,
    durationSeconds: 60,
    unitBatteryMv: 4000,
    readerFw: null,
    timedOut: false,
    source: 'log',
    receivedAt: null,
  };
}

function reading(patch: Partial<ReadingInput> & { bracketAt: number; tagId: string }): ReadingInput {
  return {
    deviceImei: DEVICE,
    batteryMv: 3600,
    rssi: -58,
    hops: 0,
    waveCount: 1,
    movementState: 1,
    lat: null,
    lon: null,
    hasGps: false,
    fwPatch: 4,
    gpsAgeSeconds: null,
    linkId: null,
    source: 'log',
    ...patch,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagexplore-infer-'));
  store = new Store(join(dir, 'test.db'), 'nobody');
  store.createOrg(ORG, 'Org A');
  store.createDevice(DEVICE, ORG, 'Reader 379');
  store.createDevice(OTHER_DEVICE, ORG, 'Reader 338');
  config = { ...loadConfig(), radioIdMinRounds: 5, carriedTagMinRounds: 10, inferenceWindowDays: 7 };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const infer = (): void => {
  const device = store.getDevice(DEVICE);
  if (!device) throw new Error('no device');
  // Well after the readings below, but inside the seven-day window.
  inferDeviceIdentities(store, config, device, T0 + 12 * 3_600_000);
};

describe('scoreRadioIdVotes', () => {
  it('picks the id the wave-one readings overwhelmingly name', () => {
    const result = scoreRadioIdVotes(
      [
        { value: 'E20', votes: 90, rounds: 9, alsoHeard: false },
        { value: 'AAAA', votes: 10, rounds: 3, alsoHeard: false },
      ],
      5,
      0.8,
    );
    expect(result.chosen).toBe('E20');
  });

  it('disqualifies a candidate this reader also hears as a tag, even at every vote', () => {
    // A reader never appears in its own discovery list, so anything that does
    // is a relay tag rather than the reader.
    const result = scoreRadioIdVotes([{ value: 'AAAA', votes: 100, rounds: 20, alsoHeard: true }], 5, 0.8);
    expect(result.chosen).toBeNull();
    expect(result.candidates[0]?.rejectedFor).toBe('also-heard');
  });

  it('abstains when a relay is taking enough of the vote to muddy it', () => {
    const result = scoreRadioIdVotes(
      [
        { value: 'E20', votes: 55, rounds: 20, alsoHeard: false },
        { value: 'AAAA', votes: 45, rounds: 20, alsoHeard: true },
      ],
      5,
      0.8,
    );
    expect(result.chosen).toBeNull();
    expect(result.candidates.find((c) => c.value === 'E20')?.rejectedFor).toBe('share-below-threshold');
  });

  it('records the candidate but chooses nothing below the round threshold', () => {
    const result = scoreRadioIdVotes([{ value: 'E20', votes: 20, rounds: 2, alsoHeard: false }], 5, 0.8);
    expect(result.chosen).toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.rejectedFor).toBe('too-few-rounds');
  });
});

describe('scoreCarriedTags', () => {
  const carried = {
    tagId: '3E1E',
    roundsSeen: 40,
    directShare: 1,
    rssiMean: -55,
    rssiVariance: 1,
    viaReaderShare: 1,
    rssiOther: null,
  };
  const distant = {
    tagId: '441F',
    roundsSeen: 9,
    directShare: 0.2,
    rssiMean: -84,
    rssiVariance: 90,
    viaReaderShare: 0,
    rssiOther: null,
  };
  const options = { minRounds: 10, minScore: 0.8, minMargin: 0.15 };

  it('picks the tag that is in every round, on wave one, strong and steady', () => {
    const result = scoreCarriedTags([carried, distant], 40, new Set(), options);
    expect(result.chosen).toBe('3E1E');
  });

  it('rejects a tag another reader hears just as well', () => {
    // Two readers in one paddock both hear the carried tag; only one of them
    // is wearing it.
    const result = scoreCarriedTags([{ ...carried, rssiOther: -57 }], 40, new Set(), options);
    expect(result.chosen).toBeNull();
    expect(result.candidates[0]?.rejectedFor).toBe('heard-better-elsewhere');
  });

  it('rejects an id that is actually a reader', () => {
    const result = scoreCarriedTags([carried], 40, new Set(['3E1E']), options);
    expect(result.chosen).toBeNull();
    expect(result.candidates[0]?.rejectedFor).toBe('is-a-radio-id');
  });

  it('abstains on a near-tie rather than picking one of two plausible answers', () => {
    const twin = { ...carried, tagId: '441F' };
    const result = scoreCarriedTags([carried, twin], 40, new Set(), options);
    expect(result.chosen).toBeNull();
    expect(result.candidates[0]?.rejectedFor).toBe('no-margin');
  });

  it('rejects a row whose signal strength is not a real reading', () => {
    // The log parser can leak a whole syslog line into a numeric column. Left
    // ungated it clamps to maximum strength and outscores the real answer.
    const result = scoreCarriedTags([{ ...carried, tagId: '837', rssiMean: 26_760_161 }, distant], 40, new Set(), options);
    expect(result.chosen).toBeNull();
    expect(result.candidates.find((c) => c.value === '837')?.rejectedFor).toBe('implausible-rssi');
  });

  it('separates a co-carried tag from one out in the veld by how steady it is', () => {
    // Real fleet figures: a tag on the animal holds ~13 dB of spread, one out
    // in the veld 30. A span that floors both at zero throws the term away.
    const steady = { ...carried, rssiVariance: 13.2 ** 2 };
    const jittery = { ...carried, tagId: '441F', rssiMean: -59.5, rssiVariance: 30.6 ** 2, directShare: 0.72 };
    const result = scoreCarriedTags([steady, jittery], 40, new Set(), options);
    expect(result.chosen).toBe('3E1E');
  });

  it('chooses nothing before there is enough evidence', () => {
    const result = scoreCarriedTags([{ ...carried, roundsSeen: 4 }], 4, new Set(), options);
    expect(result.chosen).toBeNull();
    expect(result.candidates[0]?.rejectedFor).toBe('too-few-rounds');
  });
});

describe('inferDeviceIdentities', () => {
  it('takes the radio id a pushed campaign reported outright', () => {
    for (let i = 0; i < 6; i++) {
      store.writeTagDiscoveryPost({
        deviceImei: DEVICE,
        primaryDeviceId: 0xe20,
        primaryTagId: 'E20',
        sessionUtc: Math.floor((T0 + i * BRACKET_MS) / 1000),
        receivedAt: T0 + i * BRACKET_MS,
        bracketAt: T0 + i * BRACKET_MS,
        mode: 0,
        primaryVersion: 20400,
        byteCount: 100,
        readings: [],
        round: { ...round(T0 + i * BRACKET_MS), source: 'cbor', receivedAt: T0 + i * BRACKET_MS },
      });
    }

    infer();
    expect(store.getDevice(DEVICE)).toMatchObject({ radioId: 'E20', radioIdSource: 'auto' });
  });

  it('does not count a retried POST of the same campaign twice', () => {
    const post = {
      deviceImei: DEVICE,
      primaryDeviceId: 0xe20,
      primaryTagId: 'E20',
      sessionUtc: Math.floor(T0 / 1000),
      receivedAt: T0,
      bracketAt: T0,
      mode: 0,
      primaryVersion: 20400,
      byteCount: 100,
      readings: [],
      round: { ...round(T0), source: 'cbor' as const, receivedAt: T0 },
    };
    store.writeTagDiscoveryPost(post);
    store.writeTagDiscoveryPost(post);

    expect(store.listIdentityCandidates(DEVICE, 'radio')[0]).toMatchObject({ value: 'E20', rounds: 1, exact: true });
  });

  it('surfaces two primaries on one reader instead of picking between them', () => {
    for (const primary of ['E20', 'E21']) {
      for (let i = 0; i < 6; i++) {
        const at = T0 + i * BRACKET_MS;
        store.writeTagDiscoveryPost({
          deviceImei: DEVICE,
          primaryDeviceId: primary === 'E20' ? 0xe20 : 0xe21,
          primaryTagId: primary,
          sessionUtc: Math.floor(at / 1000),
          receivedAt: at,
          bracketAt: at,
          mode: 0,
          primaryVersion: 20400,
          byteCount: 100,
          readings: [],
          round: { ...round(at), source: 'cbor', receivedAt: at },
        });
      }
    }

    infer();
    // `radio_id` is one value and both of these are real answers, so guessing
    // would be worse than leaving it for an admin.
    expect(store.getDevice(DEVICE)?.radioId).toBeNull();
    expect(store.listIdentityCandidates(DEVICE, 'radio').map((c) => c.value).sort()).toEqual(['E20', 'E21']);
  });

  it('keeps voting while a single exact candidate is still short of its threshold', () => {
    // One push is not yet evidence, but it must not silence the log vote —
    // otherwise the candidate list would sit on whatever an earlier run wrote.
    store.writeTagDiscoveryPost({
      deviceImei: DEVICE,
      primaryDeviceId: 0xe20,
      primaryTagId: 'E20',
      sessionUtc: Math.floor(T0 / 1000),
      receivedAt: T0,
      bracketAt: T0,
      mode: 0,
      primaryVersion: 20400,
      byteCount: 100,
      readings: [],
      round: { ...round(T0), source: 'cbor', receivedAt: T0 },
    });

    const readings: ReadingInput[] = [];
    const rounds: RoundInput[] = [];
    for (let i = 1; i < 9; i++) {
      const at = T0 + i * BRACKET_MS;
      rounds.push(round(at));
      readings.push(reading({ bracketAt: at, tagId: '3E1E', waveCount: 1, linkId: 'E20' }));
    }
    store.writeReadings(readings, rounds);

    infer();
    const candidates = store.listIdentityCandidates(DEVICE, 'radio');
    // The receipt count is the thing gating that evidence from being applied,
    // so the vote must not overwrite it with its own round count.
    expect(candidates.find((c) => c.value === 'E20')).toMatchObject({ exact: true, rounds: 1 });
    // Nothing is applied yet: the exact candidate has not earned it, and a
    // vote does not get to pre-empt evidence that is about to be better.
    expect(store.getDevice(DEVICE)?.radioId).toBeNull();
  });

  it('votes a scraped reader’s radio id out of its wave-one readings', () => {
    const readings: ReadingInput[] = [];
    const rounds: RoundInput[] = [];
    for (let i = 0; i < 8; i++) {
      const at = T0 + i * BRACKET_MS;
      rounds.push(round(at));
      readings.push(reading({ bracketAt: at, tagId: '3E1E', waveCount: 1, linkId: 'E20' }));
    }
    store.writeReadings(readings, rounds);

    infer();
    expect(store.getDevice(DEVICE)).toMatchObject({ radioId: 'E20', radioIdSource: 'auto' });
  });

  it('learns the carried tag from a tag that is always there, always direct and always strong', () => {
    const readings: ReadingInput[] = [];
    const rounds: RoundInput[] = [];
    for (let i = 0; i < 20; i++) {
      const at = T0 + i * BRACKET_MS;
      rounds.push(round(at));
      // On the animal: every round, wave one, hop zero, pinned RSSI.
      readings.push(reading({ bracketAt: at, tagId: '3E1E', rssi: -55 }));
      // Out in the veld: occasional, relayed, weak and variable.
      if (i % 4 === 0) {
        readings.push(reading({ bracketAt: at, tagId: '441F', rssi: -86 - (i % 3) * 4, waveCount: 3, hops: 2 }));
      }
    }
    store.writeReadings(readings, rounds);

    infer();
    expect(store.getDevice(DEVICE)).toMatchObject({ carriedTagId: '3E1E', carriedTagSource: 'auto' });
  });

  it('never writes over a carried tag an admin typed', () => {
    store.setCarriedTag(DEVICE, '441F');

    const readings: ReadingInput[] = [];
    const rounds: RoundInput[] = [];
    for (let i = 0; i < 20; i++) {
      const at = T0 + i * BRACKET_MS;
      rounds.push(round(at));
      readings.push(reading({ bracketAt: at, tagId: '3E1E', rssi: -55 }));
    }
    store.writeReadings(readings, rounds);

    infer();
    expect(store.getDevice(DEVICE)).toMatchObject({ carriedTagId: '441F', carriedTagSource: 'manual' });
    // The evidence is still recorded, so an admin can see what it would have
    // chosen and change their mind.
    expect(store.listIdentityCandidates(DEVICE, 'carried').some((c) => c.value === '3E1E')).toBe(true);
  });

  it('marks the run so the scheduler can rate-limit it', () => {
    infer();
    expect(store.getDevice(DEVICE)?.identityCheckedAt).not.toBeNull();
  });
});
