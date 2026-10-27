# Unit u6-cache — cache channels on a per-channel Durable Object

## Outcome

`cache-*`, `private-cache-*`, and `presence-cache-*` channels remember the last server-published
event and replay it to a new subscriber. The cache lives in a dedicated `Channel` Durable Object,
one instance per app and channel, with SQLite storage. A cache miss sends `pusher:cache_miss`.
`GET /apps/:appId/channels/:channelName?info=cache` returns the cached event data and its remaining
TTL. Official `pusher-js` 8.x and `pusher` 5.x clients work unmodified, and the existing 28 compat
checks stay green.

This unit does **not** implement history or the presence-info API; u7 adds them to the same
`Channel` class.

## Starting point

- Repo: `/home/kevin/.t3/projects/depush`.
- Base: local `main` at `ac04609`, tag `v0.1.0`; code head `d9a3dbe`.
- Create branch `unit/u6-cache` from `main`. You are the only writer. Never rebase or force-push.
- Read `src/hub.ts`, `src/index.ts`, `src/events.ts`, `src/protocol.ts`, `src/config.ts`,
  `src/env.ts`, `wrangler.jsonc`, `scripts/compat.mjs`, and the tests before editing.
- The compat harness is the acceptance proof, not a proxy.

## Architecture that is fixed

- Add `Channel` in `src/channel.ts` (SQLite-backed Durable Object).
- Bind it as `CHANNEL` in `wrangler.jsonc` and add migration tag `v2` with
  `new_sqlite_classes: ["Channel"]`. Keep the existing `v1` AppHub migration unchanged.
- One instance per app and channel:
  `env.CHANNEL.get(env.CHANNEL.idFromName(`${appId}:${channel}`))`.
  Include the app id so changing `PUSHER_APP_ID` does not reuse another app's cache.
- `AppHub` remains the only owner of live WebSockets and presence. A WebSocket can be accepted by
  exactly one Durable Object, and presence is live connection state. Do not move sockets or
  presence into `Channel`; do not duplicate presence. `Channel` owns durable per-channel cache.
- Do not add cache rows to `AppHub` and do not add D1 or another store.
- The `Channel` object is the only writer of its own tables. `AppHub` calls it through RPC on
  publish and subscribe. The signed HTTP cache-info route reads it through RPC.
- u7 will extend this same class with event history. Leave the shape ready for that: a `record`
  call that receives `{ name, data, userId, cache, ttlSeconds }`, even though `userId` is unused
  in u6.

## Cache protocol contract

Official Pusher cache behavior:

- Cache channel prefixes: `cache-` (public), `private-cache-` (private),
  `presence-cache-` (presence). `private-encrypted-cache-` stays rejected as encrypted.
- Cache remembers the **last server-published event** only: HTTP `/events` and
  `/batch_events` publishes. A batch event updates the cache as it is processed, so the last one
  wins. Client events (`client-*`) are delivered live but **never** update the cache.
- A new subscriber to a cache channel, after a successful
  `pusher_internal:subscription_succeeded`, receives the cached event as a normal channel event:
  `{"event":"<cached name>","channel":"<channel>","data":"<cached data>"}`.
  The cached `data` is the exact string that was published.
- A cache channel with no unexpired cache sends
  `{"event":"pusher:cache_miss","channel":"<channel>","data":"{}"}` to the new socket.
- A duplicate subscribe sends `subscription_succeeded` and replays the cache again.
- The replay and miss are sent only to the subscribing socket, never broadcast.
- The replay is sent after `subscription_succeeded` and before any `member_added` the same
  subscribe would trigger for other sockets.
- The cached event is not itself recorded as a new publish; it is a read.
- The cache is channel-level: publishing before anyone subscribes stores it, and publishing with
  `socket_id` exclusion still updates it.

## SQLite shape

One channel per Durable Object, so the cache is a single row:

```sql
CREATE TABLE IF NOT EXISTS cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_name TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)
```

Use `INSERT ... ON CONFLICT(id) DO UPDATE SET event_name = excluded.event_name, ...`.
`expires_at` is `Date.now() + ttlSeconds * 1000`. `cacheInfo` and `snapshot` treat
`expires_at <= Date.now()` as expired and delete the row before returning null.

Create the table in the constructor inside `ctx.blockConcurrencyWhile`. Use the synchronous
`ctx.storage.sql` API. No hibernation-specific code is needed; SQLite persists.

## Configuration

- Add `PUSHER_CACHE_TTL_SECONDS` to `readConfig`, `AppConfig`, `AppBindings`, and
  `.dev.vars.example`.
- Default `1800` seconds. Valid values are integers 1..1800. Follow the existing optional-timeout
  style: an absent or invalid value falls back to `1800`; a value above 1800 clamps to `1800`
  (do not let a cache outlive 30 minutes). Document the default and the ceiling.
- Add `PUSHER_CACHE_TTL_SECONDS=1800` to `.dev.vars.example`.
- The compat harness writes `PUSHER_CACHE_TTL_SECONDS=2` into its temporary `.dev.vars`.

## Code changes

### `src/protocol.ts`

- Add `isCacheChannel(channel: string): boolean` for the three supported cache prefixes.
- Do not change `channelKind`; `private-cache-*` is still `private` and `presence-cache-*` is
  still `presence`, so auth and presence keep working.

### `src/channel.ts`

- Export `CachedEvent = { name: string; data: string }`,
  `CachedEventInfo = { data: string; ttl: number }`, and the `Channel` Durable Object.
- `record(input: { name; data; userId: string | null; cache: boolean; ttlSeconds: number })`
  upserts the single cache row only when `cache` is true. `userId` is accepted for u7 and unused.
- `snapshot(): Promise<CachedEvent | null>` reads the unexpired row.
- `cacheInfo(): Promise<CachedEventInfo | null>` returns `{ data, ttl }` where `ttl` is the
  remaining whole seconds, `Math.max(0, Math.floor((expires_at - Date.now()) / 1000))`.
- All SQL values are bound; no string interpolation. Return plain objects over RPC.

### `src/config.ts`, `src/env.ts`

- Add `cacheTtlSeconds: number` to `AppConfig` and the env var.
- Add `PUSHER_CACHE_TTL_SECONDS: string | undefined` to `AppBindings`.

### `src/hub.ts`

- Add `cache: boolean` and `userId: string | null` to `BroadcastInput`.
- Add a private `channelState(channel)` helper that returns the `CHANNEL` stub for
  `${this.config.appId}:${channel}`.
- Add a private async `recordEvent(channel, { name, data, userId, cache })`. In u6 it returns
  immediately unless `cache && isCacheChannel(channel)`; otherwise calls
  `channelState(channel).record({ ..., ttlSeconds: this.config.cacheTtlSeconds })`.
- `broadcast` records **before** sending to sockets, for each channel, then fans out as today.
  The HTTP routes pass `cache: true, userId: null`.
- `subscribe`: after sending `subscription_succeeded`, call a private async
  `deliverCache(socket, channel)` that only runs for `isCacheChannel(channel)`, calls
  `snapshot()`, and sends the cached normal event or the `pusher:cache_miss` frame. Do it for both
  the duplicate-subscribe path and the new-subscription path, before `member_added`.
- `clientEvent`: record with `cache: false`; client events must not touch cache. Make the method
  async and await it from `webSocketMessage`. Derive `userId` from the presence subscription when
  the channel is presence, else `null`.
- Keep the existing frame/byte/rate-limit checks and all current behavior.

### `src/index.ts`

- Add `export { Channel } from './channel'` next to `AppHub`.
- Pass `cache: true, userId: null` on both publish routes.
- `parseChannelInfo` now accepts `cache`, but only on the single-channel route:
  - `GET /channels` with `info=cache` returns 400.
  - `GET /channels/:channelName?info=cache` on a non-cache channel returns 400.
  - On a cache channel, query the `CHANNEL` stub and return
    `{ occupied, ...attributes, cache: { data, ttl } | null }`.
  - `cache` combines with `user_count` / `subscription_count` where those apply.
- Use the signed request's `config.appId` for the Channel DO name.
- Do not add history or presence routes in this unit.

### `src/events.ts`

- Add `cache: boolean` to `ChannelInfoRequest` and map `cache` in `INFO_ATTRIBUTES`.
- `parseChannelInfo` returns `cache: false` by default.
- `channelList` rejects `info.cache` with a clear 400.
- `channelInfo` may ignore the cache flag; the route adds the cache payload. Keep the pure
  function's existing count rules intact.
- Update the existing channel tests to pass the new field.

### `wrangler.jsonc`

- Add `CHANNEL` binding with `class_name: "Channel"`.
- Add migration tag `v2` with `new_sqlite_classes: ["Channel"]`.
- Run `pnpm cf-typegen`; commit the regenerated `worker-configuration.d.ts`.

## Tests

Add pure tests where the logic lives:

- `isCacheChannel` accepts the three prefixes and rejects `cache`, `private-cache`, and
  `private-encrypted-cache-*`.
- Config TTL: absent -> 1800, 2 -> 2, 0/1801/non-numeric -> 1800.
- `parseChannelInfo('cache')` -> `cache: true`; list rejects it.
- Cache info shaping with a null and a populated cache.
- Frame builders for a cached normal event and `pusher:cache_miss` if you add helpers.
- Channel-name and cache-prefix combinations keep the existing channel-kind results.

A DO-level test using `runInDurableObject` is welcome if it is small and reliable; the compat
harness is the required proof.

## Compat harness additions

Extend `scripts/compat.mjs`; keep checks 1-28 and all existing clients working. Add checks:

29. A server publish to `cache-smoke` before any subscriber is replayed to the first
    `pusher-js` subscriber as a normal event with the published data.
30. `GET /channels/cache-smoke?info=cache` returns `occupied: true` and
    `cache: { data, ttl }` with the published data and `0 <= ttl <= 2`.
31. A second publish updates the cache: an existing subscriber receives it live, and a new
    subscriber receives the newer value immediately.
32. A new subscriber to `cache-empty` receives `pusher:cache_miss` and no cached event.
33. After the 2-second TTL elapses, cache info is `null` and a new subscriber to `cache-smoke`
    receives `pusher:cache_miss`.
34. A `private-cache-room` publish before subscribe is replayed only after auth succeeds; an
    unauthenticated/tampered subscriber cannot get it. Also assert a client event on a
    private-cache channel does not replace the cached HTTP event for a later subscriber.

Use the existing auth server; `private-cache-*` uses the private HMAC path and
`presence-cache-*` uses the presence path. Bind cache/miss listeners before the subscribe frame
can arrive. Wait at least 2200 ms for the TTL check. Disconnect clients you create. Keep the
harness count exact and print PASS lines like the existing checks.

## Docs

Update `README.md`:

- Remove cache from "not implemented"; add cache channels to the support matrix.
- Document the three prefixes, last-server-event-only, client events not cached, `cache_miss`,
  duplicate replay, and the 30-minute ceiling.
- Document `info=cache` on the single-channel endpoint and that the list endpoint rejects it.
- Update the API/limits/operations/architecture sections for the `Channel` DO, SQLite, the
  `v2` migration, and `PUSHER_CACHE_TTL_SECONDS`.
- Keep the statement that event history and the presence-info API are not in this unit.

## Gates

Run and report the output of:

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm exec wrangler deploy --dry-run`
- `pnpm compat`
- `pnpm cf-typegen` then `git status --short worker-configuration.d.ts` (must be clean after
  committing the generated file)

Commit in small, verifiable commits on `unit/u6-cache`. Do not merge to `main`; the coordinator
lands it. Commit messages are imperative with a scope.

## Standing orders

1. Target Pusher Channels protocol v7 only. Reject protocol >7 or <7 with 4007 and a missing protocol with 4008. No v1-6, XHR, flash, or fallback transports.
2. Reuse the existing Workers scaffold: Vite + Hono + Valibot + Durable Objects + Vitest in workerd. No frontend, no accounts, no teams, no quotas, no billing.
3. One app from env PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET. One AppHub Durable Object per app is the single writer for sockets and channel membership.
4. Drop-in means official pusher-js 8.x and the official pusher Node server SDK work unmodified, including HTTP signatures, body_md5, socket_id exclusion, and protocol frames. Protocol units run scripts/compat.mjs.
5. A unit is done only when pnpm check, pnpm typecheck, pnpm test, pnpm build, and the compat harness pass. Put the command output in the report.
6. One worker at a time on branch unit/<id>. Never rebase or force-push. The coordinator reviews and lands on local main. There is no remote and no PR.
7. TypeScript strict: no any, casts, ts-ignore, or non-null assertions. Valibot parses every inbound frame and HTTP body. No narration comments.
8. v1 excludes webhooks, cache channels, Live Activities, Beams, user signin/watchlists, and encrypted channels. Encrypted channels get a 4009 error; no key derivation, no shared-secret provisioning.
9. Stay inside the unit brief. Park anything else as a follow-up in the report; do not widen the diff.
10. Secrets never get committed. .dev.vars is gitignored; .dev.vars.example carries placeholders.
11. v0.2 lifts order 8's cache exclusion. Cache channels are in scope. Webhooks, encrypted channels, user signin/watchlists, terminate connections, and publish info remain out.
12. Per-channel durable state lives in a Channel Durable Object at idFromName(`${appId}:${channel}`). AppHub stays the single owner of live WebSockets and presence. Do not put cache/history rows in AppHub and do not add D1.
13. Cache channels are cache-, private-cache-, and presence-cache-. The last server-published event replays as a normal channel event after subscription_succeeded; a miss sends pusher:cache_miss. Client events are not cached. TTL is PUSHER_CACHE_TTL_SECONDS, default 1800 and at most 1800.
14. History and presence-info are signed depush extensions, not Pusher routes. Keep /channels/:name/users and every supported route unchanged. History retention is 24 hours and 1000 events per channel.
15. Every unit runs scripts/compat.mjs with the official pusher-js and pusher SDKs plus the full gate list. The harness count grows; all checks pass.
16. A unit is done only when the report has command output, the README matches the code, and wrangler types has no diff.

## Report

Return: branch and commits, files changed, exact commands and key output, compat count before and
after, tests added, README changes, and any follow-ups. Name anything you could not prove.
