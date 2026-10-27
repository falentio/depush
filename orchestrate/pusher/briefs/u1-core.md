# u1-core: Pusher v7 core loop

## Goal

A self-hoster can run the Worker, connect the unmodified official `pusher-js` 8.x client to
`/app/<key>?protocol=7`, subscribe to a public channel, and receive an event triggered with
the unmodified official `pusher` Node SDK. The depush deployment app is gone.

## Scope

Branch `unit/u1-core` in `/home/kevin/.t3/projects/depush`, created from `main`. Commit there.
Never touch `main` directly.

May write: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `wrangler.jsonc`,
`tsconfig.json`, `vitest.config.ts`, `biome.json`, `worker-configuration.d.ts`, `.gitignore`,
`README.md`, `.dev.vars.example`, `src/**`, `test/**`, `scripts/**`.
Off limits: `orchestrate/**`, and anything under `../`.

Delete the depush domain: `src/data/**`, `src/domain/**`, `src/db/**`, `src/http/**`,
`src/routes/apps.ts`, `src/routes/deployments.ts`, `src/routes/live.ts`,
`src/durable/app-channel.ts`, `drizzle.config.ts`, `drizzle/**`, `test/apps.test.ts`,
`test/deployments.test.ts`, `test/domain.test.ts`, `test/live.test.ts`,
`test/apply-migrations.ts`, `test/env.d.ts`. Remove the D1 binding, Drizzle deps/scripts, and
the `@hono/valibot-validator` dependency if it no longer earns its place.

## Protocol sources

- WebSocket v7: https://pusher.com/docs/channels/library_auth_reference/pusher-websockets-protocol/
  and a local text copy at `/tmp/pusher-ws.txt` (fragmented by HTML, still readable).
- HTTP API: https://pusher.com/docs/channels/library_auth_reference/rest-api/ and `/tmp/rest.txt`.
- Signatures: https://pusher.com/docs/channels/library_auth_reference/auth-signatures/ and `/tmp/auth.txt`.
- When the prose is ambiguous, read the real clients you install: `node_modules/pusher-js/dist/node/pusher.js`
  and `node_modules/pusher/lib/**`. They are the acceptance judge.

## Required behavior

Environment: `PUSHER_APP_ID`, `PUSHER_APP_KEY`, `PUSHER_APP_SECRET`, optional
`PUSHER_ACTIVITY_TIMEOUT` (default 120). Define an `AppBindings extends Env` for these; do not
cast. One app only. `.dev.vars.example` carries placeholders; `.dev.vars` stays gitignored.

WebSocket:

- `GET /app/:key?protocol=7&client=...&version=...` upgrades. Forward the raw request to the
  `AppHub` Durable Object binding `APP_HUB`.
- The DO assigns a socket id shaped `<digits>.<digits>`, stores per-socket state in
  `ws.serializeAttachment` so it survives hibernation, and sends as the first frame:
  `{"event":"pusher:connection_established","data":"{\"socket_id\":\"...\",\"activity_timeout\":120}"}`.
  `data` must be a JSON **string**, not an object.
- `pusher:ping` receives `{"event":"pusher:pong","data":"{}"}`. Ignore `pusher:pong`.
- `pusher:subscribe` with `data.channel` for a public channel replies
  `{"event":"pusher_internal:subscription_succeeded","channel":"<channel>","data":"{}"}`.
  Subscribe is idempotent. `pusher:unsubscribe` removes membership with no reply.
- U1 rejects channel names starting with `private-`, `presence-`, or `private-encrypted-` with
  a `pusher:error` frame. Leave a single named seam for U2 auth.
- Reject a missing `protocol` with close code 4008, a protocol other than 7 with 4007, a wrong
  key with 4001, and a non-`/app/...` path with 4005. Send a `pusher:error` frame
  (`{message, code}`) before closing. Invalid JSON or an unknown `pusher:*` event gets a
  `pusher:error` with code 4300 and keeps the socket open.
- No server-initiated pings in U1. Client pings are answered.

HTTP:

- `POST /apps/:appId/events` verifies `auth_key`, `auth_version=1.0`, `auth_timestamp` within
  ±600 s, `body_md5` against the raw body, and `auth_signature` = HMAC-SHA256 hex of
  `METHOD\nPATH\nsorted-query-without-auth_signature` (keys lowercased, values not URL-escaped).
  Use Web Crypto HMAC and a constant-time compare. MD5 comes from `@noble/hashes/legacy`.
- Body: `{ name, data, channels?: string[], channel?: string, socket_id?: string }`. `data` is
  a string, max 10 KB; at most 100 channels. `channel` and `channels` are alternatives.
- Broadcast `{"event":name,"channel":channel,"data":data}` to every socket subscribed to the
  channel except `socket_id`. Respond `200 {}`.
- Errors: 401 bad signature/key/timestamp, 400 invalid body, 413 oversized data. Body
  `{ "error": string }`.
- `GET /healthz` returns `{ "status": "ok" }` without auth.
- HTTP API app id must match `PUSHER_APP_ID`; auth key must match `PUSHER_APP_KEY`.

## Official SDK harness

Add dev deps `pusher-js@^8.6.0` and `pusher@^5.3.4`, and runtime dep `@noble/hashes@^2.4.0`.
Add `pnpm compat` -> `node scripts/compat.mjs`.

`scripts/compat.mjs` starts `pnpm exec vite --host 127.0.0.1 --port 8787 --strictPort` itself,
backing up and restoring any existing `.dev.vars`, writes test creds
(`PUSHER_APP_ID=1`, `PUSHER_APP_KEY=test-key`, `PUSHER_APP_SECRET=test-secret`,
`PUSHER_ACTIVITY_TIMEOUT=1`), polls `/healthz`, runs the checks, always kills the server, and
exits non-zero on failure. Checks:

1. `pusher-js` client A connects and subscribes to `public-smoke`; assert
   `pusher:subscription_succeeded`.
2. The `pusher` server SDK triggers `greeting` with `{hello:'world'}`; A receives the event
   with the same object.
3. Client B subscribes; trigger with `socket_id` = A's socket id; B receives, A does not.
4. A raw signed request with a tampered `auth_signature` returns 401.
5. With activity timeout 1 s, the socket stays connected for at least 3 s (ping/pong works).

Print one PASS line per check, then a summary line.

## Tests and checks

Keep pure unit tests for the API.md worked signature vector (expect
`da454824c97ba181a32ccc17a72625ba02771f50b50e1e7430e47a1f3f457e6c`) and for MD5
(`ec365a775a4cd0599faeb73354201b6f`). Add a small test for frame parsing. No test may need D1.

Run and paste output: `pnpm cf-typegen`, `pnpm check`, `pnpm typecheck`, `pnpm test`,
`pnpm build`, `pnpm exec wrangler deploy --dry-run`, `pnpm compat`.

## README

Replace the depush README with a short accurate file: what this is, the three env values,
`pnpm dev`, `pnpm compat`, and the `pusher-js` client options (`wsHost`, `wsPort`, `forceTLS`,
`enabledTransports: ['ws']`, `cluster`). U4 expands it.

## Timebox

75 minutes. On expiry, stop and report the exact failing command and partial state.

## Report

Branch, head SHA, commits, files changed, the five commands and their output, deviations, and
follow-ups you parked.

## Standing orders

S1. Target Pusher Channels protocol v7 only. Reject protocol >7 or <7 with 4007 and a missing protocol with 4008. No v1-6, XHR, flash, or fallback transports.

S2. Reuse the existing Workers scaffold: Vite + Hono + Valibot + Durable Objects + Vitest in workerd. No frontend, no accounts, no teams, no quotas, no billing. Delete the depush deployment domain, D1, and Drizzle.

S3. One app from env PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET. One AppHub Durable Object per app is the single writer for sockets and channel membership.

S4. Drop-in means official pusher-js 8.x and the official pusher Node server SDK work unmodified, including HTTP signatures, body_md5, socket_id exclusion, and protocol frames. Protocol units run scripts/compat.mjs.

S5. A unit is done only when pnpm check, pnpm typecheck, pnpm test, pnpm build, and the compat harness pass. Put the command output in the report.

S6. One worker at a time on branch unit/<id>. Never rebase or force-push. The coordinator reviews and lands on local main. There is no remote and no PR.

S7. TypeScript strict: no any, casts, ts-ignore, or non-null assertions. Valibot parses every inbound frame and HTTP body. No narration comments.

S8. v1 excludes webhooks, cache channels, Live Activities, Beams, user signin/watchlists, and encrypted-channel key derivation. Encrypted channels are auth plus pass-through.

S9. Stay inside the unit brief. Park anything else as a follow-up in the report; do not widen the diff.

S10. Secrets never get committed. .dev.vars is gitignored; .dev.vars.example carries placeholders.
