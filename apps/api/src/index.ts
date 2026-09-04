import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { logger } from 'hono/logger';
import { ensureFoundingAdmin } from './auth/foundingAdmin.js';
import { loadConfig } from './config.js';
import { Store } from './db/index.js';
import { createScheduler } from './ingest/scheduler.js';
import { createAccountApi } from './routes/account.js';
import { createAdminApi } from './routes/admin.js';
import { createApi } from './routes/api.js';
import { createAuthApi } from './routes/auth.js';

const config = loadConfig();
const store = new Store(config.dbPath, config.foundingAdminUsername);
// Creates the account on a brand-new database (e.g. a fresh Railway volume);
// a no-op once it already exists, from a signup or an earlier boot.
await ensureFoundingAdmin(store, config.foundingAdminUsername, config.foundingAdminPassword);

const app = new Hono();

app.use('*', logger());
// A snapshot response carries every whitelisted tag's latest reading, and a
// battery response a few hundred points per series — repetitive JSON that
// compresses to a fraction of its size, which matters on a phone in the field.
app.use('*', compress());

// Session cookies only make sense as Secure once the app is actually served
// over HTTPS — forcing it in local dev would mean the browser silently drops
// the cookie and login would appear to do nothing.
const cookieSecure = config.publicBaseUrl.startsWith('https://');

// Unauthenticated on purpose — this is what a platform healthcheck (Railway's
// included) polls before routing traffic to a deploy, and it should never be
// blocked on a session cookie the checker doesn't have.
app.get('/api/health', (c) => c.json({ ok: true }));

app.route('/api/auth', createAuthApi({ store, cookieSecure }));
app.route('/api/account', createAccountApi({ store }));
app.route('/api/admin', createAdminApi({ store, config }));
app.route('/api', createApi({ store, config }));

// --- Static hosting -------------------------------------------------------
// In development Vite serves the front end and proxies /api here, so this only
// engages for a production build.
const webRoot = config.webRoot ?? resolve(process.cwd(), 'apps/web/dist');
const indexHtmlPath = join(webRoot, 'index.html');
const hasWebBuild = existsSync(indexHtmlPath);

if (hasWebBuild) {
  app.use('*', serveStatic({ root: webRoot }));
  // Single-page app fallback: client routes are not files on disk.
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    return c.html(await readFile(indexHtmlPath, 'utf8'));
  });
} else {
  app.get('/', (c) =>
    c.text(
      'TagExplore API is running.\n\n' +
        'No web build found — run `npm run dev` and open http://localhost:5173,\n' +
        'or `npm run build` to produce one this server can host.\n',
    ),
  );
}

const scheduler = createScheduler(store, config);
scheduler.start();

const pruneTimer = setInterval(() => {
  try {
    store.prune();
  } catch (err) {
    console.error('Prune failed:', err);
  }
}, 3_600_000);
pruneTimer.unref();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`TagExplore API listening on http://localhost:${info.port}`);
  console.log(`  data:      ${config.dataDir}`);
  console.log(`  web build: ${hasWebBuild ? webRoot : '(none — use the Vite dev server)'}`);
  console.log(`  settings API: ${config.settingsApiToken ? 'configured' : 'not configured (devices keep their stored schedule)'}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    scheduler.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
