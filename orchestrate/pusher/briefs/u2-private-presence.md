# u2-private-presence: private and presence channels

## Goal

The unmodified official `pusher-js` client can subscribe to `private-` and `presence-` channels
with auth from an app server, and the Worker verifies that auth and runs presence membership.
Public channels and the U1 loop keep working.

## Scope

Branch `unit/u2-private-presence` from `main` (which contains the U1 landing). Commit there,
never on `main`, never in `orchestrate/**`.

May write: `src/protocol.ts`, `src/auth.ts`, `src/signature.ts`, `src/hub.ts`, `test/**`,
`scripts/compat.mjs`, `README.md`. Avoid touching `src/index.ts`, `src/events.ts`, and
`src/config.ts` unless a real need appears; if it does, say why in the report.

Do not add an HTTP auth endpoint. The app server owns `/pusher/auth`; this Worker only verifies
the auth string the client sends. Do not add client events, REST queries, or user signin.

## Protocol contract

Subscribe now carries optional `data.auth` and `data.channel_data`.

- Public: no auth; unchanged.
- Private (`private-*`): `auth` required, shaped `<app_key>:<hex>`. Sign
  `<socket_id>:<channel>` with HMAC-SHA256 and the app secret; compare in constant time.
- Presence (`presence-*`): `auth` and `channel_data` required. `channel_data` is the exact JSON
  string the app server signed. Sign `<socket_id>:<channel>:<channel_data>`. Parse it: `user_id`
  is a non-empty string or number, `user_info` is absent or an object. Dedupe users by
  `String(user_id)`.
- `private-encrypted-*`: still unsupported. Send `pusher:error` code 4009 and close 4009.
- Invalid or missing auth for a private or presence channel: `pusher:error` with code 4009 and
  close the socket with 4009. Pusher treats 4000-4099 as fatal, and `pusher-js` has no
  channel-level handler for a server auth rejection; it reports a connection `PusherError`.
  Do not keep the socket open on a failed auth.

Worked vectors (from the official auth docs) to use in unit tests:

- private: socket `1234.1234`, channel `private-foobar`, key `278d425bdf160c739803`, secret
  `7ad3773142a6692b25b8` -> signature `58df8b0c36d6982b82c3ecf6b4662e34fe8c25bba48f5369f135bf843651c3a4`.
- presence: same socket, channel `presence-foobar`, channel_data
  `{"user_id":10,"user_info":{"name":"Mr. Channels"}}` -> signature
  `afaed3695da2ffd16931f457e338e6c9f2921fa133ce7dac49f529792be6304c`.

Presence frames, all with `data` as a JSON **string**:

- Success: `pusher_internal:subscription_succeeded` with
  `{"presence":{"ids":["alice"],"hash":{"alice":{"name":"Alice"}},"count":1}}`.
  `count` is the number of unique users, not sockets.
- Join: `pusher_internal:member_added` with `{"user_id":"alice","user_info":{"name":"Alice"}}`,
  sent to other subscribers when the user's first socket joins.
- Leave: `pusher_internal:member_removed` with `{"user_id":"alice"}`, sent when the user's last
  socket unsubscribes or closes.

Private success keeps `data:"{}"`.

## Presence state

Derive presence from live socket attachments; do not keep a second member map in DO storage.
The attachments are already the single source of truth for subscriptions and they survive
hibernation. Store one subscription per channel per socket:

```ts
type Subscription = {
  channel: string
  presence?: { userId: string; userInfo: Record<string, unknown> }
}
type SocketState = { socketId: string; subscriptions: Subscription[] }
```

To answer "is this user still present", scan `this.ctx.getWebSockets()` and their attachments,
excluding the socket that is leaving. That keeps membership consistent with the sockets and
avoids stale stored state. Small self-host scale makes the scan acceptable; a storage index is
a later optimization, not U2.

Rules:

- Subscribe is idempotent. A duplicate subscribe does not add a second entry and does not emit
  another `member_added`; resend the success frame.
- The joining socket does not receive its own `member_added`.
- A second socket for the same user gets no `member_added`; the first socket's departure while
  another remains gets no `member_removed`.
- Unsubscribe removes the subscription; `member_removed` only when the last socket for that user
  leaves that channel.
- Close does the same for every presence channel on the socket, excluding the closing socket
  from the remaining scan.
- `subscription_succeeded` for presence includes every current member including the subscriber,
  deduped by user.

Keep the U1 public path, ping/pong, 4300 handling, HTTP publish, and socket_id exclusion intact.
Private and presence channels receive normal triggered events through the existing broadcast.

## Official SDK harness

Extend `scripts/compat.mjs` with a local auth HTTP server (Node `http`) on a free port. It reads
the auth POST body (`socket_id`, `channel_name`, and `params.user` from the client config) and
returns JSON. It plays the application server:

- private: `{ auth: "<key>:<hmac(secret, socket_id + ':' + channel)>" }`
- presence: `channel_data = JSON.stringify({ user_id, user_info })`, then
  `{ auth: "<key>:<hmac(secret, socket_id + ':' + channel + ':' + channel_data)>", channel_data }`
- user `tampered`: return a deliberately wrong signature.

Configure clients with
`channelAuthorization: { endpoint: 'http://127.0.0.1:<authPort>/auth', transport: 'ajax', params: { user: 'alice' } }`.
Verify the actual request shape against `node_modules/pusher-js/src/core/auth/**` if needed.

Checks to add while keeping the U1 five:

6. A `pusher-js` client subscribes to `private-room` with valid auth, and a `pusher` SDK
   `trigger` on that channel arrives.
7. A client whose auth endpoint returns a tampered signature never reaches
   `pusher:subscription_succeeded`; the client sees a `PusherError` with code 4009. Later
   operations on the valid clients still work.
8. Presence join: Alice subscribes to `presence-room`; Bob's success data has
   `members.count`, `members.get('alice')`, and Bob receives `pusher:member_added` for Alice.
9. Second socket for Alice adds no duplicate member; Alice's first socket closing removes
   nothing; her last socket closing makes Bob receive `pusher:member_removed` and drop the
   count.
10. A presence event triggered through the official server SDK arrives at Bob, and a private
    channel's event does not leak to a public-only client.

Print a PASS line per check and the total. Leave the server and auth server cleanup in
`finally`.

## Tests

Add pure tests for the private and presence signature vectors, a tampered auth rejection, and
the presence success/member payload builders. Keep the existing 12 tests and the U1 compat
checks green.

## README

Document that private and presence authorization is generated by the self-hoster's app server
and verified by the Worker; the Worker never serves `/pusher/auth` and never exposes the secret.
Show the `channelAuthorization` client option and a minimal Node auth handler shape. State that
`private-encrypted-` channels are unsupported in v1.

## Checks

`pnpm cf-typegen` if bindings changed (they should not), `pnpm check`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm exec wrangler deploy --dry-run`, `pnpm compat`. Paste output.

## Timebox

75 minutes. Stop at the cap and report the exact failing command and partial state.

## Report

Branch, head SHA, commits, files, the commands and output, deviations (especially any client
behavior that contradicted the contract), and parked follow-ups.

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
