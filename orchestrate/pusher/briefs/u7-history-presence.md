# Unit u7-history-presence — per-channel history and the presence-info API

## Outcome

Every channel gets a durable per-channel event history in its `Channel` Durable Object, and two
signed depush extensions expose it:

- `GET /apps/:appId/channels/:channelName/history?limit=&before=`
- `GET /apps/:appId/channels/:channelName/presence`

History keeps the last 24 hours and at most 1000 events per channel. The presence endpoint returns
the full live presence state (`ids`, `hash`, `count`). Pusher's `/channels/:name/users` route stays
unchanged. The cache work from u6 stays green, and `scripts/compat.mjs` grows from 34 to 40 checks.

This unit does **not** add webhooks, user signin, terminate connections, encrypted channels, or
publish `info`.

## Starting point

- Repo: `/home/kevin/.t3/projects/depush`.
- Base: local `main` after u6-cache landed; the coordinator gives you the SHA.
- Create branch `unit/u7-history-presence` from `main`. You are the only writer. Never rebase or
  force-push.
- Read u6's `src/channel.ts`, `src/hub.ts`, `src/index.ts`, `src/events.ts`, and the u6 compat
  additions before editing.
- The u6 `Channel` Durable Object is bound as `CHANNEL` and is named
  `idFromName(`${appId}:${channel}`)`. One instance per app and channel. Do not rename it.
- `AppHub` remains the single owner of live WebSockets and presence. `Channel` owns durable
  per-channel history and cache. Do not move presence or sockets into `Channel`, and do not add a
  second store.

## History data model

Add this table to the same `Channel` DO SQLite database (the cache table from u6 stays):

```sql
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  user_id TEXT,
  published_at INTEGER NOT NULL
)
```

One channel per DO, so there is no `channel` column and no channel index. `id` is the cursor.
`published_at` is epoch milliseconds. `user_id` is null for HTTP/batch publishes and for client
events on private channels; it is the sender's presence user id for client events on presence
channels. `data` is the exact published string for HTTP events and `JSON.stringify(value)` for
client events (`'null'` when the client omitted data).

### Recording

- `Channel.record` already receives `{ name, data, userId, cache, ttlSeconds }` from u6. In u7 it
  inserts one `events` row for **every** event, then updates the cache row only when `cache` is
  true.
- Record HTTP `/events` and `/batch_events` publishes, and `client-*` events.
- Do **not** record `pusher_internal:*` frames, subscription successes, `member_added`,
  `member_removed`, `pusher:cache_miss`, or cache replays. A cache replay is a read, not a publish.
- Record before the AppHub sends to sockets, as u6 already does for cache.
- Remove u6's early return in `AppHub.recordEvent` that skips non-cache channels. In u7 every
  channel gets a `Channel` DO and a history row. Keep the `cache` flag: only cache channels update
  the cache row.
- The client-event path already calls `recordEvent` with `cache: false`; keep that and make sure it
  passes the presence `user_id` (null on private).

### Retention and pruning

- Keep events for 24 hours and at most 1000 per channel.
- On each insert, delete rows older than `Date.now() - 24h`, then delete rows beyond the newest
  1000, for example:
  `DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET 1000)`.
- Use bound parameters. Do not prune on reads; a read returns what is stored.

## History API

```
GET /apps/:appId/channels/:channelName/history?limit=<1..100>&before=<id>
```

- Signed with the existing `signedRequest`; `channelName` follows the existing channel-name rule.
- `limit` defaults to 50; valid 1..100. `before` is optional; valid positive integer. Invalid
  values return 400. Unknown channels return `{ "events": [], "next_cursor": null }`.
- Results are newest first. Page using the smallest `id` in the current page as `before` on the
  next request; do not repeat that event.
- Response:

```json
{
  "events": [
    {
      "id": 42,
      "name": "greeting",
      "data": "{\"hello\":\"world\"}",
      "user_id": "alice",
      "published_at": "2026-10-27T06:00:00.000Z"
    }
  ],
  "next_cursor": "42"
}
```

- `user_id` is omitted when null. `next_cursor` is a decimal string, or null when no older page
  exists. It is the smallest id in the returned page when another page exists.
- Implement the query with `id < ? ORDER BY id DESC LIMIT ?`, fetching `limit + 1` rows to decide
  `next_cursor`; slice the extra row off.
- This route is a **depush extension**, not a Pusher API route. Document it as such. Pusher's
  project-wide `GET /apps/:appId/events` remains 404.

Add `parseHistoryQuery(limitRaw, beforeRaw)` in `src/events.ts` with Valibot, returning a tagged
result; keep all inbound parsing at the boundary. Add the route before the generic
`/channels/:channelName` route. Name the Channel DO with the signed request's `config.appId`.

## Presence-info API

```
GET /apps/:appId/channels/:channelName/presence
```

- Signed; channel name validated; presence channels only. A non-presence channel returns 400.
- Read live presence from `AppHub`, the single owner of sockets and presence. Do not add presence
  tables to `Channel`.
- Response:

```json
{
  "presence": {
    "ids": ["alice", "bob"],
    "hash": { "alice": { "name": "Alice" }, "bob": { "name": "Bob" } },
    "count": 2
  }
}
```

- Deduplicate by `String(user_id)` exactly as the subscription path does. Sort `ids` for a stable
  response. `hash` maps each id to its stored `user_info`. `count` equals `ids.length`.
- Refactor the presence payload so `presenceSubscriptionSucceeded` and the API share one
  `presenceState(members)` builder. Keep the existing subscription-success JSON shape unchanged.
- Keep `/channels/:channelName/users` exactly as it is; it remains the Pusher-compatible endpoint.
  The new route is a depush extension.
- Add `AppHub.presenceInfo(channel)` returning the state or null for a non-presence channel. The
  route decides the 400. `presence-cache-*` is a presence channel and works.

## Code changes

### `src/channel.ts`

- Add the `events` table in the same `blockConcurrencyWhile` constructor block.
- Add history insert and pruning to `record`.
- Add `history(input: { limit: number; before: number | undefined }): Promise<HistoryPage>` and
  the `HistoryEvent` / `HistoryPage` types (or import the API event type from `events.ts`).
- Keep `snapshot` and `cacheInfo` unchanged.

### `src/events.ts`

- Add `HistoryEvent`, `HistoryPage`, and `parseHistoryQuery`.
- The API event type carries `published_at` as an ISO string; do not leak epoch milliseconds.
- Keep the u6 `cache` info request field and tests working.

### `src/hub.ts`

- Remove the u6 skip so `recordEvent` calls the Channel DO for every channel; keep `cache` as
  passed (`input.cache && isCacheChannel(channel)` for HTTP, false for client events).
- Make sure `clientEvent` records before `sendToChannel` and still sends the client frame with
  `user_id` metadata.
- Add `presenceInfo(channel)` using `collectPresenceMembers` and `presenceState`.
- Do not change subscription, cache replay, or presence membership semantics.

### `src/protocol.ts`

- Add `PresenceState` and `presenceState(members)`; use it from
  `presenceSubscriptionSucceeded`. Do not change the existing wire data shape.

### `src/index.ts`

- Add the two signed routes before `/channels/:channelName`.
- Use `channelKind(channelName) === 'presence'` for the presence route.
- Use the Channel DO for history and `AppHub` for presence.
- Keep the route order and the existing `/users` route intact.

## Tests

- `parseHistoryQuery`: default 50, 1 and 100 accepted, 0/101/non-numeric rejected, `before`
  positive integer accepted, 0/non-numeric rejected.
- `presenceState`: dedupe by user id, sorted ids, hash and count; the subscription-success frame
  still matches the existing presence tests.
- History event shaping: `user_id` omitted when null, `published_at` ISO, `next_cursor` null and
  non-null cases. A small `runInDurableObject` test for insert/query/prune is welcome if reliable.
- Update any test that imports the presence frame or `ChannelInfoRequest`; keep the suite green.

## Compat harness additions

Keep checks 1-34 from u5 and u6. Add checks:

35. Three server publishes to `history-room` return newest-first history with the expected names,
    parsed data, ids, and ISO `published_at`; `limit=2` returns two events and a `next_cursor`.
36. The next page with `before=<next_cursor>` returns the remaining older event and
    `next_cursor: null`; the two pages do not repeat an id.
37. History includes a presence `client-typing` event with `user_id: "bob"` and omits `user_id`
    for an HTTP event on the same channel.
38. A publish to `cache-smoke` is in history exactly once, and the cache replay to a subscriber is
    not a second history row (query the cache channel's history).
39. The presence-info endpoint returns sorted `ids`, the `hash` user info, and `count` for
    `presence-room`; `/users` still returns the same ids.
40. The presence endpoint returns 400 for `public-smoke`; history rejects `limit=0` and
    `before=not-a-number` with 400; an unknown channel returns an empty page.

Use the official `pusher` SDK `get` for signed calls. Do not disturb the existing cache TTL timing;
run the history checks after the cache checks. Print PASS lines and keep the harness count exact.

## Docs

Update `README.md`:

- Mark per-channel history and the presence-info API as supported depush extensions, distinct from
  Pusher's `/events` API (still 404) and `/users` (unchanged).
- Add both routes to the API table with a "depush extension" note.
- Document history retention (24 hours, 1000 events per channel), ordering, `limit`, `before`,
  `next_cursor`, and the event shape.
- Document the presence response and that it reads live sockets.
- Update Operations/Architecture for the `Channel` DO per `appId:channel`, the `events` table, and
  the `v2` migration from u6.
- Update Limits and the support matrix; remove stale "history is not supported" text while keeping
  the accurate statement that Pusher's project-wide event API is not implemented.

## Gates

Run and report:

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm exec wrangler deploy --dry-run`
- `pnpm compat`
- `pnpm cf-typegen`; `git status --short worker-configuration.d.ts` must be clean

Commit in small, verifiable commits on `unit/u7-history-presence`. Do not merge to `main`; the
coordinator lands it. Commit messages are imperative with a scope.

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

Return: branch and commits, files changed, exact commands and key output, compat count, tests
added, README changes, and follow-ups. Name anything you could not prove.
