# u4-selfhost: packaging and operator docs

## Goal

A self-hoster who has never seen this repo can deploy the Worker, point official Pusher clients
at it, stand up a private/presence auth endpoint, and understand what is and is not supported.
The README stops being a unit log and becomes the operator manual.

## Scope

Branch `unit/u4-selfhost` from `main` (contains U1-U3). Commit there, never on `main`, never in
`orchestrate/**`.

May write: `README.md`, `wrangler.jsonc`, `.dev.vars.example`, and the `description` field of
`package.json`. Do not change `src/**`, `test/**`, `scripts/compat.mjs`, dependencies, or the
public API. If a doc claim cannot be proven by the code or the harness, cut the claim or mark it
unsupported; do not implement a feature to make a sentence true.

## Config work

1. Switch the Durable Object migration from `new_classes` to `new_sqlite_classes`. SQLite-backed
   Durable Objects work on the Workers free plan; KV-backed ones do not. This is a fresh
   deployment, so keep tag `v1`. If local `.wrangler/state` refuses the class-type change, remove
   that gitignored state and rerun; do not commit it.
2. Remove `compatibility_flags: ["nodejs_compat"]` if the Worker, tests, build, and compat
   harness still pass without it. The runtime code has no Node built-ins. If anything fails, put
   it back and say exactly what needed it.
3. Keep `name: "depush"`, the `APP_HUB` binding, the `AppHub` class, observability, and the
   current compatibility date. Do not add vars for the Pusher credentials; they are secrets.
4. Update `.dev.vars.example` only if a value is missing or misleading.

## README

Rewrite the whole README around the self-hoster. It must contain, in a sensible order:

- What it is: a self-hosted, single-app Pusher Channels server on Cloudflare Workers, protocol
  v7, drop-in for official `pusher-js` clients and the official `pusher` Node server SDK.
- What it is not: no dashboard, accounts, teams, quotas, billing, webhooks, cache channels,
  encrypted channels, user signin/watchlists, terminate connections, batch `info`, or history.
- A support matrix: public, private, presence, client events, HTTP publish, batch publish,
  channel list/info, presence users; and the unsupported list with the observable behavior
  (4009 for encrypted subscribe, 404 for terminate, 400 for batch `info`).
- Local quickstart: Node 22+, `pnpm install`, copy `.dev.vars.example` to `.dev.vars`, set the
  three values, `pnpm dev`, `/healthz`, then a minimal client.
- Deploy: `pnpm exec wrangler login`, three `wrangler secret put` commands, optional
  `PUSHER_ACTIVITY_TIMEOUT`, `pnpm deploy`, custom domain. Explain that `PUSHER_APP_ID` is the
  HTTP path id, `PUSHER_APP_KEY` is the client key, and `PUSHER_APP_SECRET` signs requests and
  channel auth.
- Client configuration for production: `wsHost`, `wsPort: 443`, `forceTLS: true`,
  `enabledTransports: ['ws']`, a placeholder `cluster`, `disableStats: true`; and the Node SDK
  with `host`, `port`, `useTLS`.
- Private and presence auth: the app server owns the endpoint; this Worker only verifies. Show a
  Node/Express-style handler using `pusher.authorizeChannel(socket_id, channel_name, data)` and
  the matching `channelAuthorization` client option. State that the endpoint must authenticate
  the user and must not expose the secret.
- API table with the 3 publish routes and 3 query routes plus `/healthz`. Include query
  parameters `filter_by_prefix`, `info`, and the users response. Note signed auth params on
  every `/apps` request.
- Error table: WebSocket close codes 4001/4005/4007/4008/4009 and `pusher:error` 4300/4301; HTTP
  400/401/413.
- Limits: 10 KB event data, 100 channels per publish, 10 batch events, 10 client events/s per
  socket, 200-char event names, one app per deployment, presence state ephemeral and derived
  from live sockets.
- Operations: one Durable Object per app is the single writer; hibernatable sockets; no D1 or
  other database; `wrangler tail`; `/healthz`; a DO class change needs a new migration tag;
  Cloudflare account limits and rate limiting are the operator's job.
- Development: `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm exec wrangler deploy --dry-run`, `pnpm compat`; explain that `pnpm compat` starts its
  own dev server and local auth server using test credentials.
- Architecture: a short numbered text tree from Worker route to AppHub to attachments, and the
  signed HTTP path to the same hub.
- Troubleshooting: wrong key (4001), missing/unsupported protocol (4008/4007), auth rejected
  (4009), HTTP 401 (key, timestamp, body_md5, signature), 4301 (client event rate), 404
  (unsupported route).

Use real commands and real response shapes. Do not paste volatile build sizes or test counts as
if they were permanent, and do not claim `wss` works locally without TLS. Keep it concise
enough to scan; use tables for matrices and limits.

## Checks

`pnpm cf-typegen` (expect no diff), `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm exec wrangler deploy --dry-run`, `pnpm compat`. Paste the output. `pnpm compat` must stay
18/18 and `pnpm test` 66/66.

## Timebox

60 minutes. Stop at the cap and report the exact failing command and partial state.

## Report

Branch, head SHA, commits, files, config changes with the before/after, checks and output,
deviations, and any claims you removed because you could not prove them.

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
