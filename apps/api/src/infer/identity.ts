/**
 * Working out, from the readings themselves, the two things about a reader
 * that nothing reports in a form we can just store.
 *
 * **Its radio id** — the id a tag names in its `RssiSrc` column when its data
 * reached this reader directly rather than through another tag. A pushed CBOR
 * campaign states it outright (`primaryDeviceId`), so for a pushing unit this
 * is not a guess at all; a scraped one has to be voted on.
 *
 * **Its carried tag** — the ordinary tag on the same animal that carries the
 * reader. It is what answers "where was this reader during that discovery"
 * whenever the reader's own GPS fix is too old to apply.
 *
 * Both follow the same rule: accumulate candidates with their evidence, and
 * only promote one onto `devices` when it is clearly ahead. A near-tie abstains
 * and surfaces both, because guessing between two plausible answers is worse
 * than admitting there are two. A value an admin typed is never written
 * through — that guard lives in SQL, in `Store.applyInferred*`.
 *
 * The SQL lives in `Store`; the arithmetic and every threshold live here, so
 * the scoring can be tested against fixed rows with no database.
 */

import type { DeviceIdentityCandidate, DeviceRow } from '@tagexplore/core';
import type { Config } from '../config.js';
import type { Store } from '../db/index.js';

/**
 * RSSI mapped onto 0..1. −85 dBm is about as weak as a usable reading gets and
 * −55 is roughly what something sitting on top of the reader produces, so a
 * co-carried tag lands at or near the top of this range while a tag a paddock
 * away does not.
 */
const RSSI_FLOOR_DBM = -85;
const RSSI_CEILING_DBM = -55;
/**
 * Standard deviation at which the stability term reaches zero. Measured
 * against the real fleet rather than guessed: a co-carried tag comes in around
 * 5-13 dB while tags out in the veld run 19-30, so a tighter span (12 was the
 * first attempt) floors every candidate at zero and throws the term away.
 */
const RSSI_STABILITY_SPAN_DB = 30;
/**
 * Anything outside this is not a reading. The log parser can leak a whole
 * syslog line into a numeric column — there are `rssi` values in the tens of
 * millions on record — and without this such a row clamps to maximum strength
 * and outscores the real carried tag.
 */
const RSSI_PLAUSIBLE_MIN_DBM = -130;
const RSSI_PLAUSIBLE_MAX_DBM = -20;
/**
 * How much better another reader has to hear a tag before it stops being a
 * candidate for this one. Two readers in one paddock will both hear the
 * carried tag; only one of them is wearing it.
 */
const EXCLUSIVITY_MARGIN_DB = 6;

const WEIGHTS = { coverage: 0.35, directness: 0.25, strength: 0.25, stability: 0.15 } as const;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface ScoredCandidate {
  value: string;
  rounds: number;
  score: number;
  evidence: Record<string, number>;
  rejectedFor: string | null;
}

export interface IdentityInference {
  candidates: ScoredCandidate[];
  /** The candidate clear enough to promote, or null when nothing is. */
  chosen: string | null;
}

/**
 * The wave-one vote behind a scraped reader's radio id.
 *
 * Everything heard on the first wave reached the reader directly, so its
 * `RssiSrc` names the reader. The trap is a busy relay tag, which also collects
 * wave-one mentions — so a candidate that this same device *also heard as a
 * tag* is disqualified outright: a reader never appears in its own discovery
 * list.
 *
 * Disqualified candidates stay in the denominator deliberately. If a relay is
 * taking half the wave-one vote, the real reader's share falls below the
 * threshold and nothing is promoted, which is the correct outcome — the
 * evidence genuinely is muddy.
 */
export function scoreRadioIdVotes(
  votes: Array<{ value: string; votes: number; rounds: number; alsoHeard: boolean }>,
  minRounds: number,
  minShare: number,
): IdentityInference {
  const totalVotes = votes.reduce((sum, v) => sum + v.votes, 0);
  if (totalVotes === 0) return { candidates: [], chosen: null };

  const candidates: ScoredCandidate[] = votes.map((v) => {
    const share = v.votes / totalVotes;
    const rejectedFor = v.alsoHeard
      ? 'also-heard'
      : v.rounds < minRounds
        ? 'too-few-rounds'
        : share < minShare
          ? 'share-below-threshold'
          : null;
    return {
      value: v.value,
      rounds: v.rounds,
      score: share,
      evidence: { votes: v.votes, share: Number(share.toFixed(3)), alsoHeard: v.alsoHeard ? 1 : 0 },
      rejectedFor,
    };
  });

  candidates.sort((a, b) => b.score - a.score || b.rounds - a.rounds);
  const accepted = candidates.filter((c) => c.rejectedFor === null);
  // More than one passing the share threshold is arithmetically impossible
  // above 0.5, but the guard costs nothing and keeps the rule explicit.
  const chosen = accepted.length === 1 ? (accepted[0] as ScoredCandidate).value : null;
  return { candidates, chosen };
}

export interface CarriedTagEvidenceRow {
  tagId: string;
  roundsSeen: number;
  directShare: number;
  rssiMean: number;
  rssiVariance: number;
  viaReaderShare: number;
  rssiOther: number | null;
}

/**
 * Scores each tag a reader heard on how much it looks like something strapped
 * to the same animal.
 *
 * A co-carried tag is centimetres away, so it produces a signature nothing else
 * on a farm reproduces: present in essentially every round, always on wave one,
 * very strong, and barely varying. Each of those alone has a mundane
 * explanation — a nearby tag is strong, a stationary one is stable — which is
 * why all four are weighted together rather than any one being decisive.
 *
 * `viaReaderShare` (how often the tag's own `link_id` equals this reader's
 * `radio_id`) is recorded as evidence but never scored. The radio id may itself
 * be unset or inferred, and these two inferences must not prop each other up.
 */
export function scoreCarriedTags(
  rows: CarriedTagEvidenceRow[],
  totalRounds: number,
  radioIds: Set<string>,
  options: { minRounds: number; minScore: number; minMargin: number },
): IdentityInference {
  if (totalRounds === 0) return { candidates: [], chosen: null };

  const candidates: ScoredCandidate[] = rows.map((row) => {
    const coverage = clamp01(row.roundsSeen / totalRounds);
    const directness = clamp01(row.directShare);
    const strength = clamp01((row.rssiMean - RSSI_FLOOR_DBM) / (RSSI_CEILING_DBM - RSSI_FLOOR_DBM));
    const stability = clamp01(1 - Math.sqrt(row.rssiVariance) / RSSI_STABILITY_SPAN_DB);
    const score =
      WEIGHTS.coverage * coverage +
      WEIGHTS.directness * directness +
      WEIGHTS.strength * strength +
      WEIGHTS.stability * stability;

    // Hard gates, checked before the score is allowed to mean anything.
    const heardBetterElsewhere = row.rssiOther !== null && row.rssiOther >= row.rssiMean - EXCLUSIVITY_MARGIN_DB;
    const implausible = !(row.rssiMean >= RSSI_PLAUSIBLE_MIN_DBM && row.rssiMean <= RSSI_PLAUSIBLE_MAX_DBM);
    const rejectedFor = implausible
      ? 'implausible-rssi'
      : radioIds.has(row.tagId)
        ? 'is-a-radio-id'
        : heardBetterElsewhere
          ? 'heard-better-elsewhere'
          : row.roundsSeen < options.minRounds
            ? 'too-few-rounds'
            : score < options.minScore
              ? 'score-below-threshold'
              : null;

    return {
      value: row.tagId,
      rounds: row.roundsSeen,
      score,
      evidence: {
        coverage: Number(coverage.toFixed(3)),
        directness: Number(directness.toFixed(3)),
        strength: Number(strength.toFixed(3)),
        stability: Number(stability.toFixed(3)),
        rssiMean: Number(row.rssiMean.toFixed(1)),
        rssiOther: row.rssiOther === null ? 0 : Number(row.rssiOther.toFixed(1)),
        viaReaderShare: Number(row.viaReaderShare.toFixed(3)),
      },
      rejectedFor,
    };
  });

  candidates.sort((a, b) => b.score - a.score);

  const eligible = candidates.filter((c) => c.rejectedFor === null);
  const best = eligible[0];
  if (!best) return { candidates, chosen: null };

  // The runner-up is measured against every other scored tag, not only the
  // other eligible ones: a tag disqualified on a technicality can still be
  // evidence that the picture is ambiguous.
  const runnerUp = candidates.find((c) => c.value !== best.value);
  if (runnerUp && best.score - runnerUp.score < options.minMargin) {
    best.rejectedFor = 'no-margin';
    return { candidates, chosen: null };
  }

  return { candidates, chosen: best.value };
}

/**
 * Runs both inferences for one reader and promotes whatever is clear enough.
 *
 * Synchronous: it is all local SQL and arithmetic. The caller (the scheduler)
 * rate-limits it per device, because the exclusivity query has to look across
 * every other reader in the organisation and that is not something to do on
 * the read path.
 */
export function inferDeviceIdentities(store: Store, config: Config, device: DeviceRow, nowMs: number): void {
  const since = nowMs - config.inferenceWindowDays * 86_400_000;

  // --- Radio id ---
  // Two exactly-reported candidates means two primaries report through this
  // one IMEI. `radio_id` is a single value and both are real answers, so
  // nothing is chosen and both are surfaced — picking one would be worse than
  // saying there are two. The log vote is not even worth running: its readings
  // collapse the two primaries together and would land near a coin toss.
  const exactRadio = store.listIdentityCandidates(device.imei, 'radio').filter((c) => c.exact);
  if (exactRadio.length < 2) {
    // The vote is scored and stored either way, even while a single exact
    // candidate is still short of its threshold. Skipping it there would leave
    // whatever an earlier run happened to write sitting in the table, which is
    // worse than a current best guess an admin can look at.
    const votes = store.radioIdVotes(device.imei, since);
    const inference = scoreRadioIdVotes(votes, config.radioIdMinRounds, config.radioIdMinShare);
    store.replaceInferredCandidates(device.imei, 'radio', inference.candidates, nowMs);

    const only = exactRadio[0] as DeviceIdentityCandidate | undefined;
    if (only && only.rounds >= config.radioIdMinRounds) {
      // Reported outright by the unit, which beats any number of votes.
      store.applyInferredRadioId(device.imei, only.value);
    } else if (!only && inference.chosen) {
      store.applyInferredRadioId(device.imei, inference.chosen);
    }
  }

  // --- Carried tag ---
  const evidence = store.carriedTagEvidence(device.imei, device.orgId, since);
  const carried = scoreCarriedTags(evidence.tags, evidence.totalRounds, store.allRadioIds(), {
    minRounds: config.carriedTagMinRounds,
    minScore: config.carriedTagMinScore,
    minMargin: config.carriedTagMinMargin,
  });
  store.replaceInferredCandidates(device.imei, 'carried', carried.candidates, nowMs);
  if (carried.chosen) store.applyInferredCarriedTag(device.imei, carried.chosen);

  store.markIdentityChecked(device.imei, nowMs);
}

/**
 * One device's candidates with `rejectedFor` filled in — what the admin panel
 * shows when asked why a value was chosen, or why none was. Re-derived on read
 * rather than stored, so a threshold change is reflected without waiting for
 * the next inference run.
 */
export function explainCandidates(store: Store, config: Config, device: DeviceRow): DeviceIdentityCandidate[] {
  const stored = store.listIdentityCandidates(device.imei);
  const exactRadioCount = stored.filter((c) => c.kind === 'radio' && c.exact).length;
  // The carried-tag margin is a property of the *field*, not of any one
  // candidate, so it has to be worked out here rather than read off a row —
  // and it has to be, or the panel would tell someone a value was "clear
  // enough to use" while the inference had in fact abstained over it. The
  // panel exists to explain that decision; disagreeing with it is worse than
  // saying nothing.
  const carried = stored.filter((c) => c.kind === 'carried');
  const carriedRunnerUpScore = carried.length > 1 ? (carried[1] as DeviceIdentityCandidate).score : null;

  return stored.map((c) => {
    if (c.kind === 'radio' && c.exact) {
      const rejectedFor =
        exactRadioCount > 1 ? 'share-below-threshold' : c.rounds < config.radioIdMinRounds ? 'too-few-rounds' : null;
      return { ...c, rejectedFor };
    }

    const minScore = c.kind === 'radio' ? config.radioIdMinShare : config.carriedTagMinScore;
    const minRounds = c.kind === 'radio' ? config.radioIdMinRounds : config.carriedTagMinRounds;
    if (c.rounds < minRounds) return { ...c, rejectedFor: 'too-few-rounds' };
    if (c.score < minScore) return { ...c, rejectedFor: 'score-below-threshold' };

    if (
      c.kind === 'carried' &&
      c === carried[0] &&
      carriedRunnerUpScore !== null &&
      c.score - carriedRunnerUpScore < config.carriedTagMinMargin
    ) {
      return { ...c, rejectedFor: 'no-margin' };
    }
    // An exactly-reported radio id elsewhere on this device outranks any vote,
    // so a vote that would otherwise pass is not the reason the field is set.
    if (c.kind === 'radio' && exactRadioCount === 1) return { ...c, rejectedFor: 'outranked-by-report' };

    return { ...c, rejectedFor: null };
  });
}
