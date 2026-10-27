# u3-client-rest: client events, batch publish, channel queries

## Goal

The unmodified official `pusher-js` client can trigger `client-*` events on private and presence
channels, and the unmodified official `pusher` Node SDK can batch-publish and query occupied
channels, channel counts, and presence users. Public/private/presence delivery and the U1/U2
harness stay green.

## Scope

Branch `unit/u3-client-rest` from `main` (contains the U1 and U2 landings). Commit there, never
on `main`, never in `orchestrate/**`.

May write: `src/protocol.ts`, `src/hub.ts`, `src/events.ts`, `src/index.ts`, `test/**`,
`scripts/compat.mjs`, `README.md`. Leave `src/config.ts`, `wrangler.jsonc`, and the bindings
alone unless a real need appears; explain any change.

Do not implement `POST /apps/:appId/users/:userId/terminate_connections`. It targets sockets by
the user-auth id from `pusher:signin`, which v1 excludes; presence `user_id` is a different
identity. Document it as deferred.

## Client events

Add a client frame:

```json
{ "event": "client-typing", "channel": "private-room", "data": { "typing": true } }
```

- Accept only an event name starting with `client-`, max 200 characters, on a channel the
  socket is subscribed to, and only for `private-*` or `presence-*` channels. Public channels,
  unsubscribed channels, and encrypted channels get a `pusher:error` with code 4300 and stay
  open.
- `data` may be a string or a JSON value; preserve it as sent. Reject data larger than 10 KB
  with 4300; keep the socket open.
- Broadcast `{event, channel, data}` to every other subscriber, never the sender.
- For a presence channel, include top-level `user_id` from that socket's presence subscription
  for the channel. `pusher-js` exposes it as the second argument's `metadata.user_id`. Private
  channels get no `user_id`.
- Rate limit: at most 10 client events per socket per rolling 1000 ms. The 11th gets
  `pusher:error` code 4301 and is not broadcast; the connection stays open. Rejected frames do
  not count. Keep the limiter in memory keyed by socket id; clear it on close. Hibernation may
  reset it, which is acceptable for v1.
- Client event frame size is bounded by the existing 10 KB rule; do not add a second limit.

Keep the `webSocketMessage` switch exhaustive. The frame parser should return a typed client
frame, not an `unknown` bag.

## Batch publish

`POST /apps/:appId/batch_events`, signed exactly like `/events` (one HMAC over the raw body,
`body_md5`, timestamp window).

Body: `{ "batch": [ { "name": string, "channel": string, "data": string, "socket_id"?: string } ] }`

- 1 to 10 events. Each `data` max 10 KB. Reject the whole request with 400 before broadcasting
  if any event is invalid, has no channel, or is >10 KB (413 for an oversized data field).
- Reject `private-encrypted-*` channels with 400; encrypted publishing is unsupported.
- Broadcast each event through the existing path, honoring `socket_id` exclusion.
- Successful response is `{}`. Per-event `info` is out of scope; if present, return 400 with a
  clear error rather than silently ignoring it.

The official Node SDK sends each item with a singular `channel`, not `channels`; accept that
shape. Do not require a batch-level signature per event.

## Channel queries

All three are signed GETs. The SDK calls them through `pusher.get({ path, params })`.

`GET /apps/:appId/channels?filter_by_prefix=<prefix>&info=<attrs>`

- Return only occupied channels whose name starts with the prefix.
- `info` is a comma-separated subset of `user_count` and `subscription_count`. With no `info`,
  each channel maps to `{}`.
- `user_count` is valid only for presence channels; `subscription_count` is valid only for
  non-presence channels. Requesting an attribute that does not apply to a returned channel is a
  400. `user_count` without a `filter_by_prefix` that restricts the result to presence channels
  is a 400, matching the docs.
- Response: `{ "channels": { "<name>": { ...attrs } } }`. No `occupied` field in the list.

`GET /apps/:appId/channels/:channelName?info=<attrs>`

- Always return `{ "occupied": boolean }`, plus requested attrs.
- Unknown channel: `occupied:false`, and requested counts as `0` where they apply.
- Same info applicability rules as above. Unknown info names and `cache` are 400.

`GET /apps/:appId/channels/:channelName/users`

- Presence channels only; return `{ "users": [ { "id": "<userId>" } ] }`, deduped and sorted.
- Any non-presence channel name (or a known public/private channel) is 400.
- An occupied channel with no members is `{ "users": [] }`; a presence channel that is not
  occupied is also `[]`.

Compute all three from live socket attachments in the AppHub, the same single source of truth
U2 uses. Add one snapshot scan that returns per-channel `{ subscriptionCount, userIds }`;
derive occupied and counts from it. Do not add DO storage or a second index.

## Official SDK harness

Extend `scripts/compat.mjs` using the existing clients and auth server. Add:

11. Alice's private client triggers `client-typing`; Bob's private client receives it; Alice does
    not.
12. A presence client triggers `client-typing`; another presence member receives it and
    `metadata.user_id` is the sender's presence id.
13. A public-channel client trigger produces a 4300 `PusherError` and no delivery; the
    connection remains connected.
14. Eleven rapid client events from one socket produce exactly one 4301 error and the
    connection stays connected; a fresh event after the window still works.
15. `triggerBatch` with two events (one private, one public) delivers both and returns 200.
16. `server.get({path:'/channels', params:{filter_by_prefix:'presence-', info:'user_count'}})`
    returns the occupied presence channel with the right count and no public/private channels.
17. `server.get({path:'/channels/<private>', params:{info:'subscription_count'}})` returns
    `occupied` and the socket count; `server.get({path:'/channels/<presence>', params:{info:'user_count'}})`
    returns the user count; `server.get({path:'/channels/<presence>/users'})` returns the ids.
18. `server.get({path:'/channels/<public>', params:{info:'user_count'}})` rejects with 400.

Parse the Node SDK `get` response with `await response.json()`. Keep checks 1-10 green and print
one PASS line per check.

## Tests

Add pure tests for the rate limiter boundary (10 allowed, 11th rejected, window rollover), the
client-event frame builder with and without `user_id`, batch parsing (valid, 11 events, oversized
data, encrypted channel), info applicability, and the channel snapshot aggregation. Keep the
26 existing tests green.

## README

Add the client-event and query surface, the 4300/4301 behavior, and a table of the three GET
endpoints. State that batch `info`, terminate connections, encrypted channels, cache channels,
and webhooks are not implemented.

## Checks

`pnpm cf-typegen` if bindings changed (they should not), `pnpm check`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm exec wrangler deploy --dry-run`, `pnpm compat`. Paste output.

## Timebox

90 minutes. Stop at the cap and report the exact failing command and partial state.

## Report

Branch, head SHA, commits, files, commands and output, deviations, and parked follow-ups.

## Standing orders

S1. Target Pusher Channels protocol v7 only. Reject protocol >7 or <7 with 4007 and a missing protocol with 4008. No v1-6, XHR, flash, or fallback transports.

S2. Reuse the existing Workers scaffold: Vite + Hono + Valibot + Durable Objects + Vitest in workerd. No frontend, no accounts, no teams, no quotas, no billing. Delete the depush deployment domain, D1, and Drizzle.

S3. One app from env PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET. One AppHub Durable Object per app is the single writer for sockets and channel membership.

S4. Drop-in means official pusher-js 8.x and the official pusher Node server SDK work unmodified, including HTTP signatures, body_md5, socket_id exclusion, and protocol frames. Protocol units run scripts/compat.mjs.

S5. A unit is done only when pnpm check, pnpm typecheck, pnpm test, pnpm build, and the compat harness pass. Put the command output in the report.

S6. One worker at a time on branch unit/<id>. Never rebase or force-push. The coordinator reviews and lands on local main. There is no remote and no PR.

S7. TypeScript strict: no any, casts, ts-ignore, or non-null assertions. Valibot parses every inbound frame and HTTP body. No narration comments.

S8. v1 excludes webhooks, cache channels, Live Activities, Beams, user signin/watchlists, and encrypted channels. Encrypted channels get a 4009 error; no key derivation, no shared-secret provisioning.

S9. Stay inside the unit brief. Park anything else as a follow-up in the report; do not widen the diff.

S10. Secrets never get committed. .dev.vars is gitignored; .dev.vars.example carries placeholders.
