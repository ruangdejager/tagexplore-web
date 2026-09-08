import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { Config } from '../config.js';
import type { Store } from '../db/index.js';

export interface BotApiDeps {
  store: Store;
}

export interface ProvisionApiDeps {
  store: Store;
  config: Config;
}

const BOT_LEVELS = ['dev', 'client'] as const;
type BotLevel = (typeof BOT_LEVELS)[number];

/** A presented bearer token is matched by its hash — the raw value is never stored. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Pulls the bearer token out of an `Authorization: Bearer <token>` header. */
function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? (match[1] as string).trim() : null;
}

/**
 * Resolves epoch-millisecond `from`/`to` query params into an absolute window.
 * The bot always sends explicit millisecond bounds (it does its own history-start
 * clamping), so this is deliberately simpler than the browser API's `readWindow`.
 */
function readBotWindow(query: Record<string, string | undefined>, nowMs: number): { from: number; to: number } | { error: string } {
  const to = query['to'] ? Number(query['to']) : nowMs;
  if (!Number.isFinite(to)) return { error: '`to` must be epoch milliseconds.' };
  const from = query['from'] ? Number(query['from']) : to - 72 * 3_600_000;
  if (!Number.isFinite(from)) return { error: '`from` must be epoch milliseconds.' };
  if (from >= to) return { error: '`from` must be before `to`.' };
  return { from, to };
}

/**
 * The read-only API the Telegram bot lives on. Every route is scoped to the one
 * organisation the presented token grants, at the level baked into that token —
 * the bot never sees another org's data and never picks its own org.
 */
export function createBotApi(deps: BotApiDeps): Hono<{ Variables: { orgId: string; level: string } }> {
  const api = new Hono<{ Variables: { orgId: string; level: string } }>();

  api.use('*', async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) return c.json({ error: 'Missing bearer token.' }, 401);
    const grant = deps.store.getBotTokenByHash(hashToken(token));
    if (!grant) return c.json({ error: 'Invalid token.' }, 401);
    deps.store.touchBotToken(grant.id, Date.now());
    c.set('orgId', grant.orgId);
    c.set('level', grant.level);
    await next();
  });

  /**
   * Everything the bot needs to know about itself, fetched once at start and
   * again on every poll so a level change or whitelist edit made in the web app
   * lands without redeploying the bot. `tags` is the org's whitelist — the bot
   * filters its client-facing views against it.
   */
  api.get('/context', (c) => {
    const orgId = c.get('orgId');
    const org = deps.store.getOrg(orgId);
    return c.json({
      orgId,
      orgName: org?.name ?? null,
      level: c.get('level'),
      tags: deps.store.listOrgTags(orgId),
    });
  });

  /**
   * Raw readings + round health for the window. The bot rebuilds its discovery
   * "sessions" from these, exactly as it used to from parsed logs — but the
   * scraping, parsing and merging all already happened in the web app.
   */
  api.get('/readings', (c) => {
    const window = readBotWindow(c.req.query(), Date.now());
    if ('error' in window) return c.json({ error: window.error }, 400);
    const orgId = c.get('orgId');
    return c.json({
      from: window.from,
      to: window.to,
      readings: deps.store.listReadingsWindow(orgId, window.from, window.to),
      rounds: deps.store.listRoundsWindow(orgId, window.from, window.to),
    });
  });

  return api;
}

/**
 * The server-to-server provisioning API the bot's manager uses to attach a new
 * Telegram bot to an organisation and set its dev/client level. Authenticated by
 * a single shared secret (`BOT_PROVISION_TOKEN`), not a user session — the
 * manager bot has no browser login. Disabled outright when that secret is unset.
 */
export function createProvisionApi(deps: ProvisionApiDeps): Hono {
  const api = new Hono();

  api.use('*', async (c, next) => {
    const configured = deps.config.botProvisionToken;
    if (!configured) return c.json({ error: 'Provisioning is disabled.' }, 404);
    const token = bearer(c.req.header('authorization'));
    if (!token || token !== configured) return c.json({ error: 'Unauthorised.' }, 401);
    await next();
  });

  /** The organisations a new bot can be attached to — the manager's picker list. */
  api.get('/orgs', (c) => c.json({ orgs: deps.store.listOrgs() }));

  /** Every issued token (never the secret) — powers the manager's /listbots view. */
  api.get('/tokens', (c) => c.json({ tokens: deps.store.listBotTokens() }));

  /**
   * Mint a token for one org at one level. The raw secret is returned exactly
   * once, here — it is only ever stored hashed, so it cannot be shown again.
   */
  api.post('/tokens', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const orgId = typeof body['orgId'] === 'string' ? body['orgId'] : '';
    const level = typeof body['level'] === 'string' ? body['level'].toLowerCase() : 'client';
    const label = typeof body['label'] === 'string' ? body['label'].trim() : '';

    if (!deps.store.getOrg(orgId)) return c.json({ error: 'No organisation with that id.' }, 404);
    if (!BOT_LEVELS.includes(level as BotLevel)) return c.json({ error: 'level must be dev or client.' }, 400);

    const id = nanoid(12);
    const secret = randomBytes(24).toString('base64url');
    // The bot presents `<id>.<secret>`; the id half makes a token self-identifying
    // in logs without exposing the secret, and keeps lookups a single hash match.
    const token = `${id}.${secret}`;
    deps.store.createBotToken(id, hashToken(token), orgId, level, label, Date.now());

    return c.json({ id, token, orgId, level, label }, 201);
  });

  /** Change a bot's level in place (the manager's /setlevel). */
  api.patch('/tokens/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const level = typeof body['level'] === 'string' ? body['level'].toLowerCase() : '';
    if (!BOT_LEVELS.includes(level as BotLevel)) return c.json({ error: 'level must be dev or client.' }, 400);
    if (!deps.store.setBotTokenLevel(id, level)) return c.json({ error: 'No token with that id.' }, 404);
    return c.json({ ok: true, id, level });
  });

  api.delete('/tokens/:id', (c) => {
    const id = c.req.param('id');
    if (!deps.store.deleteBotToken(id)) return c.json({ error: 'No token with that id.' }, 404);
    return c.json({ ok: true });
  });

  return api;
}
