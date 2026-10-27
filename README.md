# depush

depush is a self-hosted Pusher Channels server that runs as one Cloudflare Worker. It speaks
protocol v7, and the official `pusher-js` 8.x client and the official `pusher` Node server SDK
talk to it without changes. One deployment serves any number of apps, each with its own id, key,
and secret.

You point a client at your Worker instead of Pusher's edge, and your application server keeps
signing the channel auth it already signs. There is no Pusher account in the path.

Apps live in a Registry Durable Object, not in environment variables. The first account to sign up
becomes the admin, and that admin creates apps through a small JSON API at `/api` or the admin
console at `/console`.

## What it is not

depush has no teams, quotas, or billing, and the console is not a channel inspector. The protocol
surface covers publish, batch publish, channel queries, presence, cache channels, and client
events, plus two signed depush extensions for per-channel history and presence info. These are not
implemented:

- Webhooks.
- Encrypted channels.
- User signin and watchlists.
- Connection termination.
- Publish `info`, on a single event or on a batch event.
- Pusher's project-wide event API, `GET /apps/:appId/events`, which returns 404.

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
| Per-channel history           | Supported as a depush extension. Last 24 hours, 1000 events      |
| Presence-info API             | Supported as a depush extension. Reads the live sockets          |
| Webhooks                      | Not supported. The Worker makes no outbound calls.               |
| Cache channels                | Supported. One cached event per channel, replayed on subscribe   |
| Encrypted channels            | Not supported. Subscribe gets 4009; publish returns 400          |
| User signin, watchlists       | Not supported. `pusher:signin` fails parsing and gets 4300       |
| Connection termination        | Not supported. The route returns 404                             |
| Publish `info`                | Not supported. A single event or a batch with `info` returns 400 |
| Pusher project-wide event API | Not supported. `GET /apps/:appId/events` returns 404             |

## Quickstart

You need Node 22 or later and pnpm.

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

Set `BETTER_AUTH_SECRET` in `.dev.vars` to a long random string. Every other value in that file is
optional. Then start the dev server:

```sh
pnpm dev
```

Vite serves the Worker on `http://localhost:5173`. Check it:

```sh
curl http://localhost:5173/healthz
# {"status":"ok"}
```

The first account you create becomes the admin. Create it, then use its session cookie to create
an app. better-auth requires an `Origin` header, so send one that matches the server:

```sh
ORIGIN='http://localhost:5173'

curl -c cookies.txt -X POST "$ORIGIN/api/auth/sign-up/email" \
  -H 'content-type: application/json' -H "origin: $ORIGIN" \
  -d '{"email":"owner@example.com","password":"correct-horse-battery","name":"Owner"}'

curl -b cookies.txt -X POST "$ORIGIN/api/apps" \
  -H 'content-type: application/json' -H "origin: $ORIGIN" \
  -d '{"name":"my app"}'
# {"id":"cynwips0","key":"13f8…","secret":"4096…","name":"my app","created_at":1793103868325}
```

The sign-up response carries `"role":"admin"`. If it says `"role":"user"`, this registry already
had an account, so sign in as that first account instead. Remove `.wrangler/state/v3/do/depush-Registry`
to start the local registry over.

The response carries the app's `id`, `key`, and `secret` once. Later reads never return the secret,
so record it before you close the terminal. Use that `id` and `key` in the snippets below, and keep
the secret on your app server as `DEPUSH_APP_ID`, `DEPUSH_APP_KEY`, and `DEPUSH_APP_SECRET`.

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

## Admin console

The Worker serves an installable admin console at `/console`. Open
`http://localhost:5173/console` in development, or `https://<your-worker>/console` after deploying.

The first account you create becomes the admin. The console lists apps, creates one with a
one-time secret you can copy as a `.env` block, renames and deletes apps, and toggles sign-ups. A
later account can sign in but lands on a page explaining that only an admin can manage apps.

The console is a PWA. Install it from the browser's address bar, and it opens to an offline shell
when the network is down. `BETTER_AUTH_URL` must match the origin that serves it: 5173 for
`pnpm dev` and 4173 for `pnpm preview`. The console is deliberately small: no channel inspector,
event publisher, presence viewer, audit log, teams, invites, password reset, email verification,
or profile editing.

## Deploy

Log in, then store the auth secret:

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put BETTER_AUTH_SECRET
```

The value is any long random string, for example the output of `openssl rand -base64 32`. Session
cookies are signed with it, so changing it signs every admin out.

Apps are not Worker secrets. They live in the Registry Durable Object, and you create them through
the console at `/console` or through `/api/apps` after deploying, as in the Quickstart. An app's
`id` is the id in the HTTP path,
`/apps/:appId/events`. Its `key` is the key the client connects with. Its `secret` signs HTTP
requests and channel authorizations. Keep the secret on your app server, never in a client.

Optional, set the public origin the admin API trusts:

```sh
pnpm exec wrangler secret put BETTER_AUTH_URL
```

Set it to your Worker URL, such as `https://depush.example.com`. Without it the Worker uses the
origin of the incoming request.

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

The command runs the Vite build and then `wrangler deploy`, which applies the `v1`, `v2`, and `v3`
Durable Object migrations and prints the Worker URL. To serve it on your own hostname, add a
custom domain or route for the Worker in the Cloudflare dashboard. The zone must belong to the
same account.

## Cost

There is no subscription and no per-message price. The bill is Cloudflare's. Workers Free costs
nothing and covers about 33,000 publishes a day, but it fails closed: one daily ceiling and
publishes stop until midnight UTC. The Workers Paid plan is a $5 monthly minimum, then $0.15 per
million Durable Object requests, with socket frames billed 20 to 1, outgoing messages free, and
history inside the included storage.

Pusher bills the publish plus every delivery, so the gap widens with fan-out: a workload worth
$1,199 a month on Pusher Channels prices at about $13 here, and one worth $49 prices at about $5.
Vask is the hosted version of the same idea, billed per publish on the same edge, and it lands
between the two: $10 to $100 a month for the same six workloads, with no infrastructure to run.

Against Vask the maintenance budget is thin. A quarter hour a month at $100 an hour eats the
difference at most of these scales, so self-hosting is worth it for the control, not for the bill.

[Cost comparison](docs/cost-comparison.md) prices six workloads all three ways, free plans included,
with the assumptions, the per-meter breakdown, and `scripts/cost-model.mjs` to rerun the numbers
against your own traffic.

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
  appId: process.env.DEPUSH_APP_ID,
  key: process.env.DEPUSH_APP_KEY,
  secret: process.env.DEPUSH_APP_SECRET,
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
  appId: process.env.DEPUSH_APP_ID,
  key: process.env.DEPUSH_APP_KEY,
  secret: process.env.DEPUSH_APP_SECRET,
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

## History and presence info

Two signed routes are depush extensions, not Pusher API routes. Pusher's project-wide event API,
`GET /apps/:appId/events`, is still not implemented and returns 404.

### Channel history

`GET /apps/:appId/channels/:channelName/history` returns the events depush recorded for one
channel. A channel keeps its last 24 hours of events, up to 1000. Every HTTP publish records one
row, and so does every `client-*` event. Protocol frames are not events: a subscription success,
`member_added`, `member_removed`, and `pusher:cache_miss` never appear, and a cache replay is a
read that adds no row.

| Parameter | Values                                | Default |
| --------- | ------------------------------------- | ------- |
| `limit`   | 1 to 100                              | 50      |
| `before`  | An event id; return only older events | Absent  |

Results are newest first. Pass the smallest id from one page as `before` to fetch the next page.
`next_cursor` is that id when another page exists, and `null` otherwise. An unknown channel
returns an empty page, and an invalid `limit` or `before` returns 400.

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

`data` is the exact string your server published for an HTTP event, and the string or JSON
serialization a client sent for a `client-*` event. `published_at` is an ISO 8601 timestamp.
`user_id` is the sender's presence user id on a `client-*` event on a presence channel, and it is
omitted for an HTTP publish and for a client event on a private channel.

Pruning happens on write: a new row first drops events older than 24 hours, then drops anything
past the newest 1000. A read returns what is stored and prunes nothing.

### Presence info

`GET /apps/:appId/channels/:channelName/presence` returns the live presence state for a presence
channel, read from the sockets currently connected to the hub:

```json
{
  "presence": {
    "ids": ["alice", "bob"],
    "hash": { "alice": { "name": "Alice" }, "bob": { "name": "Bob" } },
    "count": 2
  }
}
```

`ids` is deduped and sorted, `hash` maps each id to its stored `user_info`, and `count` is the
length of `ids`. A channel that is not a presence channel returns 400, and `presence-cache-*`
works because it is a presence channel. The Pusher-compatible
`GET /apps/:appId/channels/:channelName/users` route is unchanged and reports the same ids.

Presence info is not durable. It follows the live sockets, so it is empty once the last member
leaves, and history does not replay membership.

## Admin API

Admin routes read a better-auth session cookie. The first account to sign up holds
`role = 'admin'`; every later account gets `role = 'user'`. A request with no session gets 401, and
a session whose user is not an admin gets 403.

| Method | Path                      | Purpose                                              |
| ------ | ------------------------- | ---------------------------------------------------- |
| POST   | `/api/auth/sign-up/email` | Create an account. Body: `email`, `password`, `name` |
| POST   | `/api/auth/sign-in/email` | Sign in and receive the session cookie               |
| POST   | `/api/auth/sign-out`      | Clear the session                                    |
| GET    | `/api/auth/get-session`   | Read the signed-in user, including `role`            |
| GET    | `/api/settings`           | `{ "signup_enabled": boolean }`                      |
| PATCH  | `/api/settings`           | Set `signup_enabled`                                 |
| GET    | `/api/apps`               | List apps as `{ id, key, name, created_at }`         |
| POST   | `/api/apps`               | Create an app from `{ "name": string }`, 201         |
| GET    | `/api/apps/:appId`        | Read one app, without its secret                     |
| PATCH  | `/api/apps/:appId`        | Rename an app from `{ "name": string }`              |
| DELETE | `/api/apps/:appId`        | Delete an app, 204                                   |

`POST /api/apps` is the only response that carries `secret`. The app `id` is 8 URL-safe
characters, and `key` and `secret` are 32 hex characters each, all from `crypto.getRandomValues`.
The `id` and `key` are immutable once created; only the name can change.

Sign-up is refused with 403 while `signup_enabled` is off. The exception is an empty user table:
the first account can always be created, so an operator who switches sign-up off cannot lock
themselves out.

## API

| Method | Path                                          | Auth            | Purpose                                |
| ------ | --------------------------------------------- | --------------- | -------------------------------------- |
| GET    | `/healthz`                                    | none            | Liveness check                         |
| GET    | `/app/:key?protocol=7`                        | key in the path | WebSocket upgrade                      |
| POST   | `/apps/:appId/events`                         | signed request  | Publish to up to 100 channels          |
| POST   | `/apps/:appId/batch_events`                   | signed request  | Publish 1 to 10 events                 |
| GET    | `/apps/:appId/channels`                       | signed request  | List occupied channels                 |
| GET    | `/apps/:appId/channels/:channelName`          | signed request  | Channel occupancy and counts           |
| GET    | `/apps/:appId/channels/:channelName/users`    | signed request  | Presence members                       |
| GET    | `/apps/:appId/channels/:channelName/history`  | signed request  | Per-channel history (depush extension) |
| GET    | `/apps/:appId/channels/:channelName/presence` | signed request  | Live presence info (depush extension)  |

Workers Assets serves the console. `run_worker_first` sends `/api`, `/api/*`, `/apps/*`, `/app/*`,
and `/healthz` to the Worker, so those paths keep their JSON responses. The bare `/apps` path is not
on that list. It returns the console shell as HTML with status 200 instead of the JSON 404 it
returned before the console existed; use `/api/apps` for the app list, or `/apps/:appId/...` for a
signed app route.

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

| Where           | Code   | Meaning                                                                                                                                  |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket close | `4001` | No app in the registry has that `:key`                                                                                                   |
| WebSocket close | `4005` | The upgrade path is not a route                                                                                                          |
| WebSocket close | `4007` | The `protocol` parameter is present but not `7`                                                                                          |
| WebSocket close | `4008` | The `protocol` parameter is missing                                                                                                      |
| WebSocket close | `4009` | Channel auth failed, or the channel is `private-encrypted-`                                                                              |
| `pusher:error`  | `4300` | A bad frame, an invalid channel name, a text frame over 64 KiB, a client event on a channel you do not own, or data over 10 KB           |
| `pusher:error`  | `4301` | More than 10 client events in one second                                                                                                 |
| HTTP            | `400`  | Invalid JSON, payload, event name, or channel name; publish `info`; unsupported `info`; or a plain HTTP request to `/app/:key`           |
| HTTP            | `401`  | Unknown app id in the path, `auth_key`, `auth_version`, a timestamp that is not all digits or is outside 600 s, `body_md5`, or signature |
| HTTP            | `413`  | Event data over 10,240 bytes, or a request body over 256 KiB                                                                             |

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
| History retention         | 24 hours per channel                            |
| Events kept per channel   | 1000, oldest dropped first                      |
| History page size         | 1 to 100, default 50                            |
| Apps per deployment       | No fixed limit; each app is one registry row    |

Presence state lives in the live sockets. The presence-info route reads that state, so it is
gone when the last socket leaves and the Durable Object is evicted, and nothing replays it.

The cache and the event history are durable. They survive the hub object and its sockets. The
cache is replaced only by the next server publish or dropped when it expires, and history keeps
the last 24 hours, up to 1000 events per channel.

## Operations

One `Registry` Durable Object per deployment, named `registry`, owns the app table, the settings
row, and better-auth's `user`, `session`, `account`, and `verification` tables. It is the only
writer for all of them, and it stamps the role on the user row in the same request that inserts the
row, so two concurrent first sign-ups cannot both become admin.

One `AppHub` Durable Object per app, named from the app's registry id, writes all sockets and
channel membership. The WebSocket route and the HTTP publish and query routes reach the same object, so a
publish always sees the subscriptions in one place. The object accepts hibernatable sockets:
membership lives in each socket's attachment, and a restarted object rebuilds it from the live
sockets.

One `Channel` Durable Object per app and channel, named `<app id>:<channel>`, owns the
durable per-channel cache and the `events` history table. A WebSocket can only live in one
Durable Object, so `AppHub` keeps the sockets and presence while `Channel` keeps durable state.
`AppHub` reaches a channel object over RPC on every publish, the history route queries it, and the
channel-info route reads its cache. Presence info stays in `AppHub`, over the same live sockets.

Every channel records history, so every publish reaches a `Channel` object. Only a channel whose
name uses a cache prefix updates the cache row; history records all of them. Both tables live in
the `Channel` object's SQLite database, `cache` and `events`, and neither is stored in `AppHub`.

Each app's id names its hub and channel objects, so one app's cache and history are never served
to another. There is no D1 database and no other store.

Deleting an app removes its registry row and nothing else. Its `AppHub` and `Channel` objects keep
their storage, unreachable because the id and key they were named from are gone.

The `v1` migration creates the `AppHub` class as SQLite-backed, the `v2` migration creates
`Channel` the same way, and `v3` creates `Registry`, which the Workers free plan supports. The `events` table and the `cache`
table are created inside each `Channel` instance on first use, so they need no migration of their
own. A deployed Worker only applies migration tags it has not seen, so to rename a class or change
its storage type, add a migration with a new tag. Editing an existing tag in place does not update
a deployed Worker.

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
pnpm typecheck                          # tsc for the Worker and the console
pnpm test                               # Vitest: workerd suite plus the pure client suite
pnpm test:client                        # Pure console tests only
pnpm test:compat                        # Node Vitest suite for the official pusher server SDK
pnpm fuzz                               # Seeded HTTP and WebSocket fuzz run against a local server
pnpm build                              # Vite build (Worker + client)
pnpm verify:frontend                    # Build-output and preview checks, assumes pnpm build
pnpm exec wrangler deploy --dry-run     # Check the deploy bundle and bindings
pnpm compat                             # Run the official SDKs against a local server
```

`pnpm verify:frontend` starts its own `vite preview` on 4173 and checks the SPA fallback, the
Worker JSON routes, the service worker, the manifest, and the icons against the built output. It
backs up `.dev.vars`, writes a test auth secret, and restores the file when the run ends.

`pnpm compat` starts its own dev server and local auth server. It backs up `.dev.vars`, writes test
values including `BETTER_AUTH_SECRET`, signs up the owner account, creates an app through
`/api/apps`, plays the application server for private and presence auth with that app's
credentials, runs the checks, and restores the file. Set `PUSHER_COMPAT_PORT` to choose the server port. It uses
8787 when that port is free and the next free port otherwise.

`pnpm test:compat` starts its own dev server, writes test values to `.dev.vars`, bootstraps an app
through the admin API, runs the Node Vitest suite in `test/compat` against it, and restores the
file afterwards. It starts at port 8792 and takes
the next free port unless `PUSHER_COMPAT_PORT` is set. To compare the same signed HTTP calls
against Pusher Cloud, export `PUSHER_CLOUD_APP_ID`, `PUSHER_CLOUD_APP_KEY`, and
`PUSHER_CLOUD_APP_SECRET`; the cloud block is skipped when any is missing. The suite reads those
variables from the environment and never writes them to a file. Do not commit them.

`pnpm fuzz` starts its own dev server and bootstraps an app through the admin API, so it sends no
requests to Pusher Cloud and needs no auth server. It drives the Worker over HTTP and WebSocket with cases generated
from one seed. It reports a finding and exits 1 on a 5xx response, a non-JSON response from
`/apps` or `/healthz`, a timeout, an unexpected WebSocket close, or a server exit. The allowed
WebSocket closes are 1000, 4001, 4005, 4007, 4008, and 4009. It backs up `.dev.vars` to
`.dev.vars.fuzz-backup`, writes the test values, and restores the file when the run ends,
including on Ctrl-C and SIGTERM.

```sh
FUZZ_SEED=123456789 pnpm fuzz           # Reproduce a case from a printed seed
FUZZ_ITERATIONS=500 pnpm fuzz           # More cases, default 200
PUSHER_FUZZ_PORT=8800 pnpm fuzz         # Fixed port, default is the first free port from 8793
```

`FUZZ_SEED` is an unsigned 32-bit integer. `FUZZ_ITERATIONS` is a positive integer. Both are
printed at the start. A failure prints the seed, iteration, surface, request or frames, observed
status or close code, a short body, and the tail of the server log. Rerun the same seed and
iteration count to reproduce it. The fuzzer only runs against the local server bound to 127.0.0.1.

Run `pnpm cf-typegen` after you change `wrangler.jsonc`, then commit the regenerated
`worker-configuration.d.ts`.

## Architecture

```text
Worker (src/index.ts) [1]
├── GET /healthz [1a] → {"status":"ok"}
├── /api/auth/* → better-auth handler [1f] → Registry adapter [1f1]
├── GET/PATCH /api/settings, /api/apps [1g] → admin gate → Registry [1g1]
├── GET /app/:key?protocol=7 [1b]
│   ├── Registry.appByKey [1b0] → 4001 when there is no such app
│   ├── handshake check [1b1] → 4007, 4008 before the hub
│   └── AppHub.init(config) then AppHub.fetch [1b2]
│       ├── ctx.acceptWebSocket [1b2a]
│       ├── serializeAttachment({ socketId, subscriptions }) [1b2b]
│       ├── webSocketMessage [1b2c] → parseFrame: subscribe, unsubscribe, ping, client event
│       │   ├── subscribe → Channel.snapshot → replay or pusher:cache_miss [1b2c1]
│       │   └── client event → Channel.record with cache off [1b2c2]
│       └── webSocketClose [1b2d] → leavePresence → member_removed
├── POST /apps/:appId/events [1c]
│   └── Registry.appById → verifyRequest → parseTrigger → AppHub.broadcast [1c1]
│       ├── Channel.record for every channel, cache flag for cache names [1c1a]
│       └── fan out to AppHub sockets [1c1b]
├── POST /apps/:appId/batch_events [1d]
│   └── verifyRequest → parseBatch → AppHub.broadcast per event [1d1]
└── GET /apps/:appId/channels[...] [1e]
    ├── verifyRequest → AppHub.channelSnapshot → live attachments [1e1]
    ├── info=cache → Channel.cacheInfo [1e2]
    ├── /history → Channel.history [1e3]
    └── /presence → AppHub.presenceInfo → live attachments [1e4]
```

The signed HTTP path and the socket path meet at the same `AppHub` instance, whose id is
`idFromName(app id)`. Every channel also meets a `Channel` instance, whose id is
`idFromName(<app id>:<channel>)`, on publish and on the history route.

## Troubleshooting

| Symptom                                       | Cause                                                              | Fix                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Close `4001`, "Application does not exist"    | No app in the registry has that key                                | Create an app under `POST /api/apps` and use its key                                                                                            |
| Admin API `401`                               | No session cookie                                                  | Sign in through `/api/auth/sign-in/email` and send the cookie                                                                                   |
| Admin API `403`                               | The session belongs to a non-admin                                 | Use the first account, which holds `role = 'admin'`                                                                                             |
| Sign-up `403`, "Sign-up is disabled"          | `signup_enabled` is off                                            | Turn it back on from an admin session with `PATCH /api/settings`                                                                                |
| Close `4008`                                  | No `protocol` query parameter                                      | Use official `pusher-js`, or add `protocol=7`. A proxy can strip the query                                                                      |
| Close `4007`                                  | The protocol is not `7`                                            | Use `pusher-js` 8.x, which sends `7`                                                                                                            |
| Close `4009`                                  | Channel auth rejected, or an encrypted channel                     | Sign `socket_id:channel`, check the key and secret, and send back the exact `channel_data`                                                      |
| HTTP `401`                                    | A signed request did not verify                                    | Check `auth_key`, the clock skew against 600 s, `body_md5`, and the signed path and query                                                       |
| `pusher:error` `4301`                         | More than 10 client events in one second                           | Send fewer, or batch them on the server                                                                                                         |
| `pusher:cache_miss`                           | The cache channel holds no unexpired event                         | Publish with the HTTP API, or raise `PUSHER_CACHE_TTL_SECONDS`, up to 1800                                                                      |
| HTTP `404`                                    | Route not implemented                                              | Terminate connections and Pusher's project-wide event API do not exist                                                                          |
| `pusher:error` `4300`, "Invalid message"      | Unknown frame, such as `pusher:signin`, or an invalid channel name | Send only `pusher:subscribe`, `pusher:unsubscribe`, `pusher:ping`, `pusher:pong`, or `client-*` frames, on a channel that follows the name rule |
| `pusher:error` `4300`, "Message exceeds 64KB" | A text frame over 64 KiB                                           | Keep each frame under 64 KiB                                                                                                                    |
| HTTP `413`                                    | The body is over 256 KiB, or the data over 10 KB                   | Send less data, or split the batch                                                                                                              |
