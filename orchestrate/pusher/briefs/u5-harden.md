# u5-harden: close the documented gaps

## Goal

The documented limits and error codes are enforced and proven, and the remaining publish
inconsistencies are gone. No new features. Official clients keep working; every U1-U4 check
stays green.

## Scope

Branch `unit/u5-harden` from `main` (contains U1-U4). Commit there, never on `main`, never in
`orchestrate/**`.

May write: `src/**`, `test/**`, `scripts/compat.mjs`, `README.md`. Leave `wrangler.jsonc`,
dependencies, and the public route set alone unless a tested need appears.

## Required changes

1. **Encrypted publish parity.** `POST /apps/:appId/events` must reject any `private-encrypted-*`
   channel with 400, like `/batch_events` already does. No event is broadcast.
2. **Single-event `info` parity.** The official Node SDK accepts an `info` field on
   `trigger(...)` and sends it in the JSON body, not the query. A single event with `info`
   (body field or query parameter) must return 400 with a clear error. `/batch_events` already
   does this per event.
3. **HTTP body ceiling.** Reject an unauthenticated or authenticated request whose body exceeds
   256 KiB with 413 before verifying or buffering it all. Honor `Content-Length` when present,
   and stream-read with a hard cap when it is absent. Do not change the 10 KiB event-data rule or
   the batch shape.
4. **WebSocket frame ceiling.** A text frame over 64 KiB gets a `pusher:error` 4300 and is not
   parsed; the socket stays open. Binary frames keep their current 4300 path. Measure UTF-8
   bytes, not JS code units.
5. **Channel-name rule.** Enforce the official clients' rule everywhere a channel name enters:
   1 to 200 characters, only `A-Za-z0-9_-=@,.;`. Apply it to subscribe frames, client events,
   single publish (`channel`/`channels`), batch events, and the three channel query routes.
   Invalid names get 4300 on the socket and 400 on HTTP. Put the schema in one place and import
   it; do not copy the regex.
6. **Strict timestamp.** `auth_timestamp` must be all digits before parsing. `123abc` must not
   pass as `123`. Keep the ±600 s window.
7. **Close cleanup.** Remove the redundant `socket.close(code, reason)` call at the top of
   `webSocketClose`. The socket is already closing; the call can throw on abnormal codes and skip
   `member_removed`. Prove the clean-disconnect presence check still passes. If you find runtime
   evidence the call is required, stop and report instead of guessing.
8. **README.** Update the limits, errors, and validation rows for the body/frame ceilings, the
   channel-name rule, and single-event `info`; keep every other claim true.

## Raw protocol checks

Extend `scripts/compat.mjs` with checks that use Node's global `WebSocket` and `fetch`, no new
dependencies. Keep checks 1-18. Add:

19. Wrong key (`/app/wrong?protocol=7`) sends `pusher:error` 4001 and closes 4001.
20. `protocol=6` sends 4007 and closes 4007.
21. Missing `protocol` sends 4008 and closes 4008.
22. A WebSocket upgrade to `/nope` sends 4005 and closes 4005.
23. A valid socket that sends `not json` gets 4300, then still answers `pusher:ping` with
    `pusher:pong`; close it cleanly.
24. A valid socket that subscribes to `private-encrypted-x` gets 4009 and closes 4009.
25. A valid socket that sends a `pusher:subscribe` with a 201-character channel gets 4300 and
    stays usable (ping/pong).
26. A 70 KiB text frame gets 4300 and leaves the socket usable.
27. An unauthenticated `POST /apps/1/events` with a 300 KiB body returns 413.
28. An unauthenticated `POST /apps/1/events` signed with a valid HMAC but carrying an encrypted
    channel returns 400. Use the existing test credentials; build the signature with the same
    helper style as check 4.

The handshake checks must read the error frame before the close when the runtime delivers both;
do not assert on timing. If Node drops the frame before close, assert the close code and record
the observed behavior in the report.

## Tests

Add unit tests for the channel-name schema (valid charset, 200/201, empty), strict timestamp
(`123abc`, `-1`, valid), single-event `info` rejection, encrypted single publish, the frame-size
boundary, and the body-cap helper where it can be tested without a live server. Keep the 66
existing tests.

## Checks

`pnpm cf-typegen` (expect no diff), `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm exec wrangler deploy --dry-run`, `pnpm compat`. All must pass. The compat harness must
report every check, including the raw ones.

## Timebox

90 minutes. Stop at the cap and report the exact failing command and partial state.

## Report

Branch, head SHA, commits, files, checks and output, raw-check results, deviations, and parked
follow-ups. Call out any place where the official SDK's behavior contradicted the brief.

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
