# pusher-compatible server

Goal: a self-hosted Worker that existing Pusher Channels clients can point at with only host and port changes.

Consumer: a self-hoster running a single app for personal or small-team projects. They configure one app id/key/secret, deploy, and use their existing pusher-js and Pusher server SDK integrations.

Non-goals for v1: multi-tenancy, teams, sharing, quotas, billing, webhooks, cache channels, Live Activities, Beams, user signin/watchlists, server-side encrypted-channel keys. Accounts arrived with the registry, and the console arrived in v0.3.

Architecture:

- Hono routes on Workers: `GET /app/:key` upgrades to the AppHub Durable Object; `/apps/:appId/*` is the signed HTTP API; `/healthz` is open.
- One AppHub DO per app holds all WebSockets and channel membership. It is the only writer for channel state, so ordering and presence refcounts are serialized structurally.
- Hibernatable WebSockets; per-socket state lives in the attachment so it survives eviction.
- Valibot parses every frame and HTTP body. HMAC-SHA256 signatures, MD5 body hashes, and timestamp windows are verified at the boundary.
- No database on the send path. Channel state is ephemeral, as Pusher's is.

Proof: official `pusher-js` client and official `pusher` Node SDK run unmodified in `scripts/compat.mjs` against a dev server.

Units:

| id                  | track  | state  | outcome                                                                                                                    |
| ------------------- | ------ | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| u1-core             | server | landed | v7 handshake, public channels, ping/pong, signed publish, socket_id exclusion, official SDK harness; depush domain removed |
| u2-private-presence | server | landed | private and presence auth, presence membership and member events; encrypted channels stay rejected                         |
| u3-client-rest      | server | landed | client events and rate limit, batch events, channel and user queries; terminate deferred with user signin                  |
| u4-selfhost         | docs   | landed | README, env example, deploy steps, client configuration, compat script docs                                                |
| u5-harden           | server | landed | error codes/close codes, limits, hibernation and eviction, raw protocol tests                                              |

No remote, no PRs. Landing is a coordinator fast-forward of `unit/<id>` into local `main`; the ledger keys by commit SHA.

## v0.2 — cache, history, presence info

The first extension adds durable per-channel features without moving the live socket path:

- A dedicated `Channel` Durable Object per app and channel (`idFromName(`${appId}:${channel}`)`)
  owns SQLite cache and history. `AppHub` remains the single owner of live WebSockets and presence.
- Cache channels (`cache-`, `private-cache-`, `presence-cache-`) replay the last server-published
  event as a normal event after subscription success; a miss sends `pusher:cache_miss`; TTL is at
  most 30 minutes. Client events are not cached.
- A signed per-channel history API keeps 24 hours and 1000 events per channel.
- A signed presence-info API returns the full live `{ids, hash, count}` state; the Pusher `/users`
  route is unchanged.
- A `v2` migration adds the `Channel` SQLite class. The cache/history routes are depush extensions.

Units:

| id                  | track  | state   | outcome                                                           |
| ------------------- | ------ | ------- | ----------------------------------------------------------------- |
| u6-cache            | server | landed  | per-channel Channel DO, cache replay/miss, cache info, TTL        |
| u7-history-presence | server | landed  | per-channel history API and live presence-info API on the same DO |

All v0.2 units landed. Final verification at `447f10a`: `pnpm check` 32 code files, `pnpm typecheck`,
`pnpm test` 123/123, `pnpm build`, `pnpm exec wrangler deploy --dry-run`, and `pnpm compat` 40/40
with official `pusher-js` 8.6 and `pusher` 5.3. Tag `v0.2.0` marks the landed state. No remote and
no PRs.

## v0.3 — admin console

The console is a React 19 + TanStack Router + Tailwind v4 client, built by the root Vite project
and served by the same Worker at `/console`. It installs as a PWA.

- The first account becomes the admin. A later account can sign in but reaches the forbidden page,
  and it never fetches `/api/apps`.
- The admin lists, creates, renames, and deletes apps, and toggles sign-ups. A new app's secret is
  shown once, never returned by the list, and never written to the URL or web storage.
- Workers Assets serves the console shell. The four Worker prefixes stay in `run_worker_first`.
  Bare `/apps` is served by the shell, so it returns the SPA instead of a JSON 404.

Units:

| id         | track | state  | outcome                                                                       |
| ---------- | ----- | ------ | ----------------------------------------------------------------------------- |
| u8-console | web   | review | React console at `/console`, installable PWA, one-time secret, sign-up switch |

Proof: `pnpm typecheck`, `pnpm test` for the workerd and client suites, `pnpm build`,
`node scripts/verify-frontend.mjs`, `pnpm exec wrangler deploy --dry-run`, and the browser checks in
the pull request. Close criteria: every command passes, the secret stays out of the list, URL, and
storage after acknowledgement, and a non-admin never fetches `/api/apps`.

## Close (v0.1.0)

All five units landed on local `main`. Final verification at `d9a3dbe`: `pnpm check` 37 files, `pnpm typecheck`, `pnpm test` 93/93, `pnpm build`, `pnpm exec wrangler deploy --dry-run`, and `pnpm compat` 28/28 with official `pusher-js` 8.6 and `pusher` 5.3. Tag `v0.1.0` marks the landed state. No remote and no PRs.
