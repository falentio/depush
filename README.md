# depush

depush is a self-hosted Pusher Channels server that runs as one Cloudflare Worker. It speaks
protocol v7, and the official `pusher-js` 8.x client and the official `pusher` Node server SDK
talk to it without changes. One deployment serves one app.

You point a client at your Worker instead of Pusher's edge, and your application server keeps
signing the channel auth it already signs. There is no Pusher account in the path.

## What it is not

depush has no dashboard, accounts, teams, quotas, or billing. The protocol surface covers publish,
batch publish, channel queries, presence, cache channels, and client events. These are not
implemented:

- Webhooks.
- Encrypted channels.
- User signin and watchlists.
- Connection termination.
- Publish `info`, on a single event or on a batch event.
- Event history.
- A presence-info API.

## Support

| Capability                    | Status                                                           |
| ----------------------------- | ---------------------------------------------------------------- |
| Public channels               | Supported                                                        |
| Private channels              | Supported, with auth from your app server                        |
| Presence channels             | Supported, with auth from your app server                        |
| Client events                 | Supported on private and presence channels                       |
| HTTP publish                  | Supported, with `socket_id` exclusion                            |
| Batch publish                 | Supported, 1 to 10 events                                        |
| Channel list and channel info | Supported, with `user_count`, `subscription_count`, and `cache`  |
| Presence users                | Supported                                                        |
| Webhooks                      | Not supported. The Worker makes no outbound calls.               |
| Cache channels                | Supported. One cached event per channel, replayed on subscribe   |
| Encrypted channels            | Not supported. Subscribe gets 4009; publish returns 400          |
| User signin, watchlists       | Not supported. `pusher:signin` fails parsing and gets 4300       |
| Connection termination        | Not supported. The route returns 404                             |
| Publish `info`                | Not supported. A single event or a batch with `info` returns 400 |
| Event history                 | Not supported. `GET /apps/:appId/events` returns 404             |

## Quickstart

You need Node 22 or later and pnpm.

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

Set `PUSHER_APP_ID`, `PUSHER_APP_KEY`, and `PUSHER_APP_SECRET` in `.dev.vars`. Then start the
dev server:

```sh
pnpm dev
```

Vite serves the Worker on `http://localhost:5173`. Check it:

```sh
curl http://localhost:5173/healthz
# {"status":"ok"}
```

Subscribe from a browser or from Node with the official client. Locally the socket is plain
`ws`, so `forceTLS` stays `false`.

```js
import Pusher from 'pusher-js'

const pusher = new Pusher('your-app-key', {
  cluster: 'mt1',
  wsHost: '127.0.0.1',
  wsPort: 5173,
  forceTLS: false,
  enabledTransports: ['ws'],
  disableStats: true,
})

const channel = pusher.subscribe('public-smoke')
channel.bind('greeting', (data) => console.log(data))
```

Publish with the official Node SDK, pointed at the same port:

```js
import PusherServer from 'pusher'

const server = new PusherServer({
  appId: 'your-app-id',
  key: 'your-app-key',
  secret: 'your-app-secret',
  host: '127.0.0.1',
  port: '5173',
  useTLS: false,
})

await server.trigger('public-smoke', 'greeting', { hello: 'world' })
```

## Deploy

Log in, then store the three credentials as Worker secrets:

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put PUSHER_APP_ID
pnpm exec wrangler secret put PUSHER_APP_KEY
pnpm exec wrangler secret put PUSHER_APP_SECRET
```

`PUSHER_APP_ID` is the id in the HTTP path, `/apps/:appId/events`. `PUSHER_APP_KEY` is the key the
client connects with. `PUSHER_APP_SECRET` signs HTTP requests and channel authorizations. Keep the
secret on the Worker and your app server, never in a client.

Optional, set the ping interval the client receives in `pusher:connection_established`:

```sh
pnpm exec wrangler secret put PUSHER_ACTIVITY_TIMEOUT
```

The value is a whole number of seconds, 1 or more. An invalid value falls back to 120, which is
also the default.

Optional, set how long a cache entry lives:

```sh
pnpm exec wrangler secret put PUSHER_CACHE_TTL_SECONDS
```

The value is a whole number of seconds from 1 to 1800. An absent or invalid value falls back to
1800, and a larger value is clamped to 1800. The ceiling keeps a cached event from outliving the
30 minutes Pusher allows, and 1800 is also the default.

Build and deploy:

```sh
pnpm deploy
```

The command runs the Vite build and then `wrangler deploy`, which applies the `v1` and `v2`
Durable Object migrations and prints the Worker URL. To serve it on your own hostname, add a
custom domain or route for the Worker in the Cloudflare dashboard. The zone must belong to the
same account.

## Client configuration

Point the client at the Worker. On a deployed Worker the socket is `wss` on port 443.

| Option              | Value                      | What it does                                    |
| ------------------- | -------------------------- | ----------------------------------------------- |
| `wsHost`            | your Worker host           | Replaces the Pusher edge host                   |
| `wsPort`            | `443`                      | Where the Worker answers `wss`                  |
| `forceTLS`          | `true`                     | Uses `wss`                                      |
| `enabledTransports` | `['ws']`                   | Uses the WebSocket transport only               |
| `cluster`           | any value, such as `'mt1'` | Placeholder; `wsHost` decides where it connects |
| `disableStats`      | `true`                     | Stops statistics requests to Pusher             |

```js
const pusher = new Pusher('your-app-key', {
  cluster: 'mt1',
  wsHost: 'depush.example.com',
  wsPort: 443,
  forceTLS: true,
  enabledTransports: ['ws'],
  disableStats: true,
})
```

The Node SDK takes the same destination as `host`, `port`, and `useTLS`:

```js
const server = new PusherServer({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_APP_KEY,
  secret: process.env.PUSHER_APP_SECRET,
  host: 'depush.example.com',
  port: '443',
  useTLS: true,
})
```

## Private and presence auth

Your application server authorizes `private-*` and `presence-*` subscriptions. The Worker verifies
the `auth` string the client sends. It never serves an auth endpoint and never exposes the app
secret.

The signature is HMAC-SHA256, hex encoded, over `<socket_id>:<channel>`. A presence channel signs
`<socket_id>:<channel>:<channel_data>`. The response carries `auth` as `<app_key>:<signature>`,
and for presence the exact `channel_data` string that was signed.

The official Node SDK builds both. This Express handler authenticates the user first, then signs:

```js
import express from 'express'
import PusherServer from 'pusher'

const app = express()
const pusher = new PusherServer({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_APP_KEY,
  secret: process.env.PUSHER_APP_SECRET,
  host: 'depush.example.com',
  port: '443',
  useTLS: true,
})

app.post('/pusher/auth', express.urlencoded({ extended: false }), (request, response) => {
  if (request.user === undefined) {
    response.sendStatus(401)
    return
  }

  const { socket_id: socketId, channel_name: channelName } = request.body
  const presence = channelName.startsWith('presence-')
    ? { user_id: request.user.id, user_info: { name: request.user.name } }
    : undefined

  response.json(pusher.authorizeChannel(socketId, channelName, presence))
})
```

Wire your session middleware before this handler so it sets `request.user` and rejects anonymous
requests. Without that middleware the check above always returns 401. The endpoint must
authenticate the user before it signs anything, because a signed auth string is enough to join
the channel.

Point the client at that endpoint:

```js
const pusher = new Pusher('your-app-key', {
  cluster: 'mt1',
  wsHost: 'depush.example.com',
  wsPort: 443,
  forceTLS: true,
  enabledTransports: ['ws'],
  disableStats: true,
  channelAuthorization: {
    endpoint: 'https://app.example.com/pusher/auth',
    transport: 'ajax',
  },
})
```

Membership follows the sockets. A user's first socket sends `pusher:member_added` to the other
subscribers. A second socket for the same user sends the subscription success frame without a
second member. The user's last socket to leave sends `pusher:member_removed`. `user_id` is a
non-empty string or a number, `user_info` is an object, and members dedupe by `String(user_id)`.

A rejected auth and any `private-encrypted-` channel get `pusher:error` code 4009 and a socket
close with code 4009.

## Cache channels

A cache channel remembers the last event your server published to it, and replays that event to
every new subscriber. There are three prefixes:

| Prefix            | Channel kind                                |
| ----------------- | ------------------------------------------- |
| `cache-`          | Public                                      |
| `private-cache-`  | Private, with the same auth as `private-`   |
| `presence-cache-` | Presence, with the same auth as `presence-` |

`private-encrypted-cache-*` stays an encrypted channel and gets 4009.

Only HTTP publishing fills the cache: `POST /apps/:appId/events` and
`POST /apps/:appId/batch_events`. The last published event wins, so a publish with a `socket_id`
exclusion still updates the cache, and the last event of a batch is the one kept. A client event
is delivered live but never cached. The replay is a read, so it is not recorded as a new publish
and does not reset the cache TTL.

A new subscriber first receives `pusher_internal:subscription_succeeded` and then, when the cache
holds an unexpired event, that event as a normal channel event:

```json
{ "event": "greeting", "channel": "cache-smoke", "data": "{\"hello\":\"world\"}" }
```

`data` is the exact string your server published. When nothing is cached, or the entry expired,
the subscriber receives a miss instead:

```json
{ "event": "pusher:cache_miss", "channel": "cache-smoke", "data": "{}" }
```

The replay and the miss go only to the subscribing socket. Subscribing twice replays the cache
twice. Publishing before anyone subscribes stores the event, so the first subscriber gets it too.

An entry lives for `PUSHER_CACHE_TTL_SECONDS`, which defaults to 1800 seconds and cannot exceed
1800. Expired entries are dropped the next time the cache is read.

## API

| Method | Path                                       | Auth            | Purpose                       |
| ------ | ------------------------------------------ | --------------- | ----------------------------- |
| GET    | `/healthz`                                 | none            | Liveness check                |
| GET    | `/app/:key?protocol=7`                     | key in the path | WebSocket upgrade             |
| POST   | `/apps/:appId/events`                      | signed request  | Publish to up to 100 channels |
| POST   | `/apps/:appId/batch_events`                | signed request  | Publish 1 to 10 events        |
| GET    | `/apps/:appId/channels`                    | signed request  | List occupied channels        |
| GET    | `/apps/:appId/channels/:channelName`       | signed request  | Channel occupancy and counts  |
| GET    | `/apps/:appId/channels/:channelName/users` | signed request  | Presence members              |

Every `/apps` request carries the auth parameters the official SDK adds: `auth_key`,
`auth_timestamp`, `auth_version=1.0`, and `auth_signature`. A request with a non-empty body also
carries `body_md5`. The timestamp is a whole number of seconds, all digits, within 600 seconds of
the Worker's clock. The signature covers the method, the path, and the query string without
`auth_signature`.

Publish takes `name`, `data`, and either `channels` with up to 100 names or one `channel`, plus an
optional `socket_id` to exclude. Send `data` as a string. The Node SDK serializes objects for you.
The response is `{}`. A body over 256 KiB returns 413. A `private-encrypted-` channel returns 400,
and so does `info`, whether the Node SDK puts it in the body or a client puts it in the query.

Batch publish takes `{ "batch": [ { "channel": "...", "name": "...", "data": "..." } ] }` with 1
to 10 events. Each item carries a singular `channel` and may set `socket_id`. One invalid event
rejects the whole request with 400 before anything is broadcast, whether the payload, the channel
name, an encrypted channel, or an `info` field is at fault. The response is `{}`.

Channel list and info take two query parameters:

| Parameter          | Values                                                                      |
| ------------------ | --------------------------------------------------------------------------- |
| `filter_by_prefix` | A channel name prefix, for example `presence-`                              |
| `info`             | A comma-separated subset of `user_count`, `subscription_count`, and `cache` |

`user_count` applies only to presence channels, and the list endpoint needs a `filter_by_prefix`
that selects presence channels. `subscription_count` applies only to other channels. `cache`
applies only to a single channel whose name uses a cache prefix, so the list endpoint rejects it
with 400, as does a non-cache channel. Asking for an attribute that does not apply returns 400,
as does an unknown attribute.

A channel name in the path, and `filter_by_prefix` when present, must follow the channel-name rule
in Limits. A name outside it returns 400.

Response shapes:

```json
{ "channels": { "presence-room": { "user_count": 2 } } }
{ "occupied": true, "subscription_count": 3 }
{ "occupied": true, "cache": { "data": "{\"hello\":\"world\"}", "ttl": 1793 } }
{ "occupied": true, "user_count": 2, "cache": null }
{ "users": [ { "id": "alice" }, { "id": "bob" } ] }
```

Counts and members come from the live sockets. The users list is deduped and sorted, and only
presence channels have one. `cache` is the cached event's `data` and its remaining `ttl` in whole
seconds, or `null` when nothing is cached. It combines with `user_count` on a
`presence-cache-*` channel and with `subscription_count` on a `cache-*` or `private-cache-*`
channel.

## Errors

| Where           | Code   | Meaning                                                                                                                                |
| --------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket close | `4001` | The `:key` does not match `PUSHER_APP_KEY`                                                                                             |
| WebSocket close | `4005` | The upgrade path is not a route                                                                                                        |
| WebSocket close | `4007` | The `protocol` parameter is present but not `7`                                                                                        |
| WebSocket close | `4008` | The `protocol` parameter is missing                                                                                                    |
| WebSocket close | `4009` | Channel auth failed, or the channel is `private-encrypted-`                                                                            |
| `pusher:error`  | `4300` | A bad frame, an invalid channel name, a text frame over 64 KiB, a client event on a channel you do not own, or data over 10 KB         |
| `pusher:error`  | `4301` | More than 10 client events in one second                                                                                               |
| HTTP            | `400`  | Invalid JSON, payload, event name, or channel name; publish `info`; unsupported `info`; or a plain HTTP request to `/app/:key`         |
| HTTP            | `401`  | Wrong app id in the path, `auth_key`, `auth_version`, a timestamp that is not all digits or is outside 600 s, `body_md5`, or signature |
| HTTP            | `413`  | Event data over 10,240 bytes, or a request body over 256 KiB                                                                           |

A channel auth failure sends `pusher:error` 4009 and then closes the socket with 4009. The 4300
and 4301 errors leave the connection open.

## Limits

| Limit                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| Event data                | 10,240 bytes of UTF-8                           |
| HTTP request body         | 262,144 bytes                                   |
| WebSocket text frame      | 65,536 bytes of UTF-8, then `pusher:error` 4300 |
| Channels per publish      | 100                                             |
| Events per batch          | 10                                              |
| Client events per socket  | 10 per rolling 1000 ms                          |
| Event name                | 200 characters                                  |
| Channel name              | 1 to 200 of `A-Za-z0-9_-=@,.;`                  |
| Cache TTL                 | 1800 seconds, default and maximum               |
| Cached events per channel | 1, the last server publish                      |
| Apps per deployment       | 1                                               |

Presence state lives in the live sockets. It is gone when the last socket leaves and the Durable
Object is evicted, and nothing replays it.

The cache is durable. It survives the hub object and its sockets, and it is replaced only by the
next server publish or dropped when it expires.

## Operations

One `AppHub` Durable Object per app, named from `PUSHER_APP_ID`, writes all sockets and channel
membership. The WebSocket route and the HTTP publish and query routes reach the same object, so a
publish always sees the subscriptions in one place. The object accepts hibernatable sockets:
membership lives in each socket's attachment, and a restarted object rebuilds it from the live
sockets.

One `Channel` Durable Object per app and channel, named `<PUSHER_APP_ID>:<channel>`, owns the
durable per-channel cache. A WebSocket can only live in one Durable Object, so `AppHub` keeps the
sockets and presence while `Channel` keeps the cache. `AppHub` reaches a channel object over RPC
on publish and on subscribe, and the channel-info route reads it the same way.

There is no D1 database and no other store. Changing `PUSHER_APP_ID` points the Worker at a fresh,
empty hub and fresh, empty channel objects, so one app's cache is never served to another.

The `v1` migration creates the `AppHub` class as SQLite-backed, and the `v2` migration creates
`Channel` the same way, which the Workers free plan supports. A deployed Worker only applies
migration tags it has not seen, so to rename a class or change its storage type, add a migration
with a new tag. Editing an existing tag in place does not update a deployed Worker.

Run `wrangler tail` to watch requests and logs:

```sh
pnpm exec wrangler tail
```

`/healthz` answers from the Worker and does not touch the Durable Object, so it proves the Worker
is up, not that a hub is reachable.

The Worker does not rate-limit HTTP publishing or the query routes. If you expose them, add
Cloudflare rate limiting rules or your own. Cloudflare account limits also apply to the Worker and
to the Durable Object.

## Development

```sh
pnpm check                              # Biome lint and format check
pnpm typecheck                          # tsc --noEmit
pnpm test                               # Vitest in workerd
pnpm build                              # Vite build
pnpm exec wrangler deploy --dry-run     # Check the deploy bundle and bindings
pnpm compat                             # Run the official SDKs against a local server
```

`pnpm compat` starts its own dev server and local auth server with test credentials. It backs up
`.dev.vars`, writes test values, plays the application server for private and presence auth, runs
the checks, and restores the file. Set `PUSHER_COMPAT_PORT` to choose the server port. It uses
8787 when that port is free and the next free port otherwise.

Run `pnpm cf-typegen` after you change `wrangler.jsonc`, then commit the regenerated
`worker-configuration.d.ts`.

## Architecture

```text
Worker (src/index.ts) [1]
├── GET /healthz [1a] → {"status":"ok"}
├── GET /app/:key?protocol=7 [1b]
│   ├── handshake check [1b1] → 4001, 4007, 4008 before the hub
│   └── AppHub.fetch [1b2]
│       ├── ctx.acceptWebSocket [1b2a]
│       ├── serializeAttachment({ socketId, subscriptions }) [1b2b]
│       ├── webSocketMessage [1b2c] → parseFrame: subscribe, unsubscribe, ping, client event
│       │   ├── subscribe → Channel.snapshot → replay or pusher:cache_miss [1b2c1]
│       │   └── client event → Channel.record with cache off [1b2c2]
│       └── webSocketClose [1b2d] → leavePresence → member_removed
├── POST /apps/:appId/events [1c]
│   └── verifyRequest → parseTrigger → AppHub.broadcast [1c1]
│       ├── Channel.record for each cache channel, before fan-out [1c1a]
│       └── fan out to AppHub sockets [1c1b]
├── POST /apps/:appId/batch_events [1d]
│   └── verifyRequest → parseBatch → AppHub.broadcast per event [1d1]
└── GET /apps/:appId/channels[...] [1e]
    ├── verifyRequest → AppHub.channelSnapshot → live attachments [1e1]
    └── info=cache → Channel.cacheInfo [1e2]
```

The signed HTTP path and the socket path meet at the same `AppHub` instance, whose id is
`idFromName(PUSHER_APP_ID)`. A cache channel also meets a `Channel` instance, whose id is
`idFromName(<app id>:<channel>)`.

## Troubleshooting

| Symptom                                       | Cause                                                              | Fix                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Close `4001`, "Application does not exist"    | The client key is not `PUSHER_APP_KEY`                             | Use the key from the same app as the Worker                                                                                                     |
| Close `4008`                                  | No `protocol` query parameter                                      | Use official `pusher-js`, or add `protocol=7`. A proxy can strip the query                                                                      |
| Close `4007`                                  | The protocol is not `7`                                            | Use `pusher-js` 8.x, which sends `7`                                                                                                            |
| Close `4009`                                  | Channel auth rejected, or an encrypted channel                     | Sign `socket_id:channel`, check the key and secret, and send back the exact `channel_data`                                                      |
| HTTP `401`                                    | A signed request did not verify                                    | Check `auth_key`, the clock skew against 600 s, `body_md5`, and the signed path and query                                                       |
| `pusher:error` `4301`                         | More than 10 client events in one second                           | Send fewer, or batch them on the server                                                                                                         |
| `pusher:cache_miss`                           | The cache channel holds no unexpired event                         | Publish with the HTTP API, or raise `PUSHER_CACHE_TTL_SECONDS`, up to 1800                                                                      |
| HTTP `404`                                    | Route not implemented                                              | Terminate connections, event history, and the presence-info API do not exist                                                                    |
| `pusher:error` `4300`, "Invalid message"      | Unknown frame, such as `pusher:signin`, or an invalid channel name | Send only `pusher:subscribe`, `pusher:unsubscribe`, `pusher:ping`, `pusher:pong`, or `client-*` frames, on a channel that follows the name rule |
| `pusher:error` `4300`, "Message exceeds 64KB" | A text frame over 64 KiB                                           | Keep each frame under 64 KiB                                                                                                                    |
| HTTP `413`                                    | The body is over 256 KiB, or the data over 10 KB                   | Send less data, or split the batch                                                                                                              |
