import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { Store } from '../db/index.js';
import type { LiveBus } from '../events/bus.js';
import type { Scheduler } from '../ingest/scheduler.js';
import { decodeTagDiscovery, storeTagDiscovery } from '../ingest/tagDiscovery.js';

export interface TagDiscoveryApiDeps {
  store: Store;
  config: Config;
  bus?: LiveBus;
  scheduler?: Scheduler;
}

/** The FarmRanger's own modem IMEI — 15 decimal digits, and the only identification on the request. */
const IMEI_RE = /^\d{15}$/;

/**
 * The push-ingest endpoint a FarmRanger unit POSTs a tag-discovery campaign to:
 *
 *   POST /api/v2018-02-04/units/<imei>/tagdiscovery
 *   Content-Type: application/octet-stream
 *   <CBOR body>
 *
 * Three things about this route are dictated by the firmware rather than chosen:
 *
 * **It always answers 200.** The modem driver compares the response code to 200
 * exactly — 201, 202 and 204 are all errors to it — and on an error the unit
 * retries once inside the same cellular session and then *drops* the campaign
 * rather than persisting it across a reboot. So a 400 for a body we cannot
 * parse does not buy us a corrected resend; it costs us the campaign and a
 * round of the unit's battery. The failure is reported in the (ignored) body
 * and in the log instead, and the raw bytes are logged so a bad body can still
 * be diagnosed. The same campaign is in the unit's flash syslog either way, so
 * the log-scraping path remains the backstop.
 *
 * **There is no authentication.** The firmware's HTTP POST path sends no custom
 * headers at all — no bearer token, no API key — so there is nothing to check
 * beyond the IMEI in the path, which is not a secret. This is a real gap, not a
 * decision; it matches how these units already talk to the FarmRanger API and
 * is accepted for this test round only.
 *
 * **`Content-Type` is `application/octet-stream`, not `application/cbor`.** The
 * modem's `AT+QHTTPCFG="contenttype"` only offers a fixed set of codes, so the
 * header is not asserted on at all.
 */
export function createTagDiscoveryApi(deps: TagDiscoveryApiDeps): Hono {
  const api = new Hono();

  api.post('/:imei/tagdiscovery', async (c) => {
    const imei = c.req.param('imei');
    const receivedAt = Date.now();
    const body = new Uint8Array(await c.req.arrayBuffer());

    // Full hex, not a prefix: the point of it is to be diffed byte for byte
    // against the unit's own debug log, which prints the encoded length and
    // record count it believes it sent. A worst-case campaign is 2136 bytes.
    if (deps.config.tagDiscoveryDebug) {
      console.debug(
        `[tagdiscovery] imei=${imei} bytes=${body.length} hex=${Buffer.from(body).toString('hex').toUpperCase()}`,
      );
    }

    if (!IMEI_RE.test(imei)) {
      console.warn(`[tagdiscovery] rejected: path IMEI is not 15 digits (imei=${imei}, bytes=${body.length})`);
      return c.json({ ok: false, error: 'IMEI must be 15 decimal digits.' }, 200);
    }

    const decoded = decodeTagDiscovery(body);
    if (!decoded.ok) {
      console.warn(`[tagdiscovery] imei=${imei} bytes=${body.length} undecodable: ${decoded.error}`);
      return c.json({ ok: false, error: decoded.error }, 200);
    }

    const campaign = decoded.campaign;
    let result;
    try {
      result = storeTagDiscovery(deps.store, deps.config, imei, campaign, receivedAt, body.length, deps.bus);
    } catch (err) {
      // Still a 200 — a storage fault is ours, and making the unit bin the
      // campaign over it helps nobody.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tagdiscovery] imei=${imei} store failed: ${message}`);
      return c.json({ ok: false, error: 'Could not store the campaign.' }, 200);
    }

    // The one thing a campaign cannot carry is where the unit was when it ran,
    // so the events API is asked for that now rather than at the next poll —
    // which is what puts the reader's fix inside the applicability window of
    // the readings that just arrived.
    //
    // Fire-and-forget on purpose: the response must not wait on it. The modem
    // treats anything but a prompt 200 as an error, retries once inside the
    // same short cellular session, and then drops the campaign.
    if (result.outcome === 'stored') {
      void deps.scheduler?.notifyPush(imei).catch(() => {
        // `pollDevicePosition` already logs its own failures.
      });
    }

    console.info(
      `[tagdiscovery] imei=${imei} primary=${campaign.primaryTagId ?? campaign.primaryDeviceId} ` +
        `session=${campaign.sessionUtc} mode=${campaign.mode} records=${campaign.tags.length} ` +
        `skipped=${campaign.skippedRecords} bytes=${body.length} -> ${result.outcome}`,
    );

    return c.json(
      {
        ok: result.outcome === 'stored' || result.outcome === 'duplicate',
        outcome: result.outcome,
        primaryTagId: campaign.primaryTagId,
        sessionUtc: campaign.sessionUtc,
        mode: campaign.mode,
        records: campaign.tags.length,
        skippedRecords: campaign.skippedRecords,
        bracketAt: result.bracketAt,
        readingsWritten: result.readingsWritten,
      },
      200,
    );
  });

  return api;
}
