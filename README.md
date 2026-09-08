# TagExplore

A map-first web app for Farmranger tag discovery. It reads each reader device's
raw syslog from the Farmranger API on that device's own schedule, parses the tag
discovery rounds out of it, stores every reading, and puts the result on a
satellite map with battery history behind it.

It is also the source of truth the Telegram tag bot now reads from (see
*Telegram bot integration* below), with the parts a chat window could not do:
pan and zoom over real imagery, click a tag for its full metadata, and chart
several tags' battery over any date range you choose.

## Telegram bot integration

This app is the only place Farmranger logs are scraped and parsed. The Telegram
tag bot no longer touches the logs at all — it reads one organisation's stored
data back over two small HTTP surfaces:

- **Read API** — `GET /api/bot/context` (the org, its dev/client level, and its
  tag whitelist) and `GET /api/bot/readings?from&to` (raw readings + round health
  in a window, which the bot rebuilds its discovery "sessions" from). Authed by a
  per-bot **bot access token** as `Authorization: Bearer <token>`; only the
  token's hash is stored (`bot_tokens` table), and it scopes strictly to one
  organisation at one level.
- **Provisioning API** — `GET /api/provision/orgs` and
  `POST | PATCH | DELETE /api/provision/tokens`, used by the bot's manager to
  attach a new bot to an organisation and set its level. Server-to-server, authed
  by a single shared secret `BOT_PROVISION_TOKEN`; **blank disables it entirely**,
  so a deployment not running the bot exposes nothing extra.

The web app shows nothing about the bot — this is purely a data feed.

## Access model

Three levels, in this order:

- **Organisation** — the unit everything hangs off. Devices belong to one, users
  belong to one, and the tag whitelist is per organisation.
- **User** — `user` sees only their own organisation's whitelisted tags; `admin`
  additionally manages organisations, users, devices and whitelists, and can
  look at any organisation from the header. Anyone may sign up, but a new
  account sees nothing until an admin places it in an organisation.
- **Device (IMEI)** — a reader, registered by an admin against one organisation.
  Everything a device hears is stored against that organisation.

`FOUNDING_ADMIN_USERNAME` is promoted to admin on every boot, so there is always
a way in. It only ever grants, so demoting it later (once a second admin exists)
sticks.

There is deliberately no dev/client split yet — there is no behavioural
difference to gate on until the feature set settles. When there is, it lands as
another value in `UserRole` rather than as a new concept.

### Tags

A tag enters the system through a device: it appears in the parsed log, and its
readings are stored immediately. It becomes *visible* only once an admin adds it
to that organisation's whitelist. Tags heard but not whitelisted show up in
Admin → Tags as a queue to add with one click. Removing a tag drops the claim,
not the readings — adding it back brings its whole history with it.

## Ingest schedule

Polling follows each device's own daily report schedule, read from the settings
API (`GET <base><imei>/settings`, bearer token):

```
"dailyReportStartTime":   "04:10:00"
"dailyReportInterval":    "01:00:00"
"dailyReportCountPerDay": 19
```

That is a *bounded* series, not an open-ended repeat: 19 reports at 04:10,
05:10, … 22:10, then nothing until the next morning. Each report's log is read
`pollOffsetMinutes` later — 10 by default — so the fetches land at 04:20, 05:20,
… 22:20 and the device is left alone overnight. Times are Johannesburg
wall-clock, which is what the units report (`timezoneAdjust: 7200`).

Every device stores those four numbers, defaulted to exactly that fleet setting
so a newly registered device polls sensibly before its real settings have been
read. With `SETTINGS_API_TOKEN` set, the first three are refreshed from the
device itself every six hours; an admin can also edit all four by hand in
Admin → Devices, for a device whose settings cannot be read. A settings API that
is down never stops the log ingest — the stored schedule carries it.

A device with no readings yet is backfilled `BACKFILL_DAYS` back (7 by default),
a day per request. Every poll re-reads a few hours further back than strictly
needed, because devices upload a bracket late often enough to matter; the
readings primary key `(bracket, device, tag)` makes the re-read a no-op.

## Persistence

Every log fetch — scheduled, on a backfill, or from Admin → "Read now" — is
parsed and written to the database on the spot. Nothing is re-fetched to answer
a question: the map, the tag card and the battery chart all read stored rows, so
history survives restarts and stays queryable over any range regardless of what
the API still serves.

## Log parsing

`packages/core` holds the parser, ported from the bot and covered by the same
fixtures (`packages/core/test/fixtures/`). The awkward parts it handles:

- **Self-describing columns.** The device prints a CSV header under
  `Tag Discovery (advanced|basic):` and the column order has already changed
  between firmware versions, so it is read every time rather than assumed.
- **Undated anchors.** Firmware v2.1.x drops into minimal syslog mode around a
  discovery round, so the block header carries no date. Dates are carried onto
  those anchors from the ordinary log lines around them, forwards and backwards,
  stepping a day at each midnight rollover.
- **Retries.** A `LOG TIMEOUT` block is usually followed seconds later by a
  successful retry. Blocks are bracketed to the nearest 15 minutes and the
  timed-out one is dropped in favour of the retry; only a bracket where nothing
  succeeded is recorded as a timed-out round.
- **Non-tags.** A firmware transfer logs one-row "discoveries" with 8-character
  progress IDs. Those are not tags and are dropped.

## Layout

```
packages/core   parser, session merger, battery/age thresholds, shared API types
apps/api        Hono + node:sqlite: auth, admin, org-scoped queries, ingest
apps/web        React + Vite + Leaflet: map, sidebar, tag card, battery trends
```

`node:sqlite` ships with Node, so there is no native module to compile and no
toolchain in the runtime image. Passwords are hashed with Node's own `scrypt`
for the same reason.

## Running it

```
npm install
cp .env.example .env
npm run dev
```

`npm run dev` starts three watchers — core, the API on :8787, and Vite on :5173
proxying `/api` to it. Open http://localhost:5173, sign up, and (as the founding
admin) add an organisation, a device IMEI, and the tag IDs that organisation may
see.

```
npm test          # parser, store, ingest, scheduler and auth tests
npm run typecheck
npm run build     # core -> api -> web; the API then serves apps/web/dist itself
```

## Deploying

Same shape as the other services: build, attach a volume, point `DATA_DIR` at
it, and set `PUBLIC_BASE_URL` to the real https URL so the session cookie is
issued as Secure. `npm start` runs the built API, which serves the built web app
from the same origin — no separate static host, and no CORS.

### Railway

`railway.json` at the repo root already points Railway at `npm run build` /
`npm start` and `/api/health` for its healthcheck; `.nvmrc` pins the Node
version `node:sqlite` needs without `--experimental-sqlite`. What's still a
manual, per-project step:

1. **Create the service** from this repo (Railway auto-detects Node via
   Nixpacks; `railway.json` covers build/start/healthcheck).
2. **Attach a volume** to the service, mounted at e.g. `/data`. Without this
   the database lives on the container's own disk and is wiped on every
   redeploy.
3. **Set environment variables** (see `.env.example` for the full list —
   nothing in it is committed, all of it has to be set in Railway):
   - `DATA_DIR=/data` — wherever the volume is mounted.
   - `PUBLIC_BASE_URL=https://<the-railway-domain>` — required for the
     session cookie to be issued `Secure`; login silently does nothing over
     HTTP without it.
   - `FOUNDING_ADMIN_USERNAME` / `FOUNDING_ADMIN_PASSWORD` — the always-admin
     account created on first boot of a fresh database.
   - `SETTINGS_API_TOKEN` if device schedules should self-refresh from the
     Farmranger settings API; the logs API needs no key.
   - `BOT_PROVISION_TOKEN` — only if the Telegram bot connects here; set the same
     value on the bot's `WEB_PROVISION_TOKEN`. Leave unset to keep the
     provisioning API off.
4. **Deploy**, then confirm `/api/health` returns `{"ok":true}` and login
   works with the founding admin.

### Carrying over the existing local database

A fresh volume starts with an empty database — the local one (wherever
`DATA_DIR` in `.env` points, gitignored, never pushed) has to be copied onto
the volume by hand once the service exists. Confirm the path first — see the
note on `DATA_DIR` above; a relative value can leave the real file somewhere
other than the plain `./data` it looks like at a glance.

1. Checkpoint the WAL into the main file first, so there is one clean file to
   copy rather than three (`tagexplore.db` / `-wal` / `-shm`). No `sqlite3`
   CLI needed — `node:sqlite` is already what the app itself uses:
   ```
   node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.env.DB_PATH); db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); db.close();" DB_PATH=<path-to-tagexplore.db>
   ```
   (set `DB_PATH` however your shell does env vars for one command, e.g.
   `DB_PATH=... node -e ...` in bash, `$env:DB_PATH=...` then run it in
   PowerShell).
2. Copy it onto the volume. `railway ssh` opens a shell in the running
   container with the volume mounted; piping the file through it avoids
   needing any extra tooling in the image:
   ```
   railway ssh --service <service-name> -- "cat > /data/tagexplore.db" < <path-to-tagexplore.db>
   ```
   (`railway link` first if the CLI isn't already pointed at this project.)
3. Restart the service so it opens the copied file instead of whatever it
   created on first boot.

Do this before real traffic hits the new deploy — copying over a database
the live service already has open is asking for a corrupt file, not a
restore.
