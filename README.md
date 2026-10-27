# depush

A self-hosted Pusher Channels server on Cloudflare Workers. One Worker, one app, protocol v7.
Official `pusher-js` clients and the official `pusher` Node server SDK talk to it unmodified.

## Configuration

Set three values as Worker secrets (or in `.dev.vars` locally, see `.dev.vars.example`):

| Variable            | Meaning                                        |
| ------------------- | ---------------------------------------------- |
| `PUSHER_APP_ID`     | App id used in `POST /apps/:appId/events`      |
| `PUSHER_APP_KEY`    | App key used by the client and in `auth_key`   |
| `PUSHER_APP_SECRET` | Secret used for HMAC-SHA256 request signatures |

Optional: `PUSHER_ACTIVITY_TIMEOUT` in seconds (default `120`), sent to the client in
`pusher:connection_established`.

## Run

```sh
pnpm install
pnpm dev          # http://127.0.0.1:5173, Worker served by the Cloudflare Vite plugin
pnpm compat       # starts its own dev server on 127.0.0.1:8787 and proves the official SDKs work
```

`pnpm compat` starts its own dev server on `127.0.0.1` (port 8787 when free, the next free port otherwise) and a local auth server on the next free port. It backs up `.dev.vars`, writes test credentials, plays the application server for the private and presence checks, runs the checks, and restores the file.

## Client

Point the official client at the Worker's host and port:

```js
const pusher = new Pusher(PUSHER_APP_KEY, {
  cluster: 'mt1',
  wsHost: '127.0.0.1',
  wsPort: 8787,
  forceTLS: false,
  enabledTransports: ['ws'],
})
const channel = pusher.subscribe('public-smoke')
channel.bind('greeting', (data) => console.log(data))
```

Trigger from a server with the official Node SDK:

```js
const server = new Pusher({ appId, key, secret, host: '127.0.0.1', port: '8787', useTLS: false })
await server.trigger('public-smoke', 'greeting', { hello: 'world' })
```

## Private and presence channels

Your application server authorizes `private-*` and `presence-*` subscriptions. The Worker only
verifies the `auth` string the client sends: it never serves `/pusher/auth` and never exposes the
app secret.

Sign `<socket_id>:<channel>` for a private channel and
`<socket_id>:<channel>:<channel_data>` for a presence channel with HMAC-SHA256 and the app
secret. Return `<app_key>:<signature>`. A presence response also carries the exact
`channel_data` string that was signed.

The examples below reuse the `server` SDK instance from [Client](#client). That SDK builds both
values:

```js
const auth = server.authorizeChannel(socketId, channelName)
// { auth: 'key:signature' }

const presenceAuth = server.authorizeChannel(socketId, channelName, {
  user_id: 'alice',
  user_info: { name: 'Alice' },
})
// { auth: 'key:signature', channel_data: '{"user_id":"alice","user_info":{"name":"Alice"}}' }
```

A minimal handler reads the client's form-encoded `socket_id`, `channel_name`, and any extra
params, then returns that JSON:

```js
import { createServer } from 'node:http'

createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const params = new URLSearchParams(body)
    const socketId = params.get('socket_id')
    const channelName = params.get('channel_name')
    const user = params.get('user')
    const data = channelName?.startsWith('presence-')
      ? { user_id: user, user_info: { name: user } }
      : undefined
    const auth = server.authorizeChannel(socketId, channelName, data)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(auth))
  })
}).listen(3000)
```

Point the client at that endpoint with the `channelAuthorization` client option:

```js
const pusher = new Pusher(PUSHER_APP_KEY, {
  cluster: 'mt1',
  channelAuthorization: {
    endpoint: 'https://example.com/pusher/auth',
    transport: 'ajax',
    params: { user: 'alice' },
  },
})

const presence = pusher.subscribe('presence-room')
presence.bind('pusher:subscription_succeeded', (members) => {
  members.count // unique users, not sockets
  members.get('alice') // { id: 'alice', info: { name: 'Alice' } }
})
presence.bind('pusher:member_added', (member) => console.log(member.id))
presence.bind('pusher:member_removed', (member) => console.log(member.id))
```

Membership follows the sockets. A user's first socket emits `pusher:member_added` to the other
subscribers; a duplicate subscribe re-sends the success frame without a second entry; the user's
last socket to leave emits `pusher:member_removed`. `user_id` is a non-empty string or a number,
`user_info` is an object, and members dedupe by `String(user_id)`.

An invalid or missing `auth`, and any `private-encrypted-` channel, gets `pusher:error` with code
`4009` and a socket close with code `4009`. Encrypted channels are not supported in this version.

## Client events

A subscribed client triggers `client-*` events on `private-*` and `presence-*` channels:

```js
privateChannel.bind('client-typing', (data, metadata) => console.log(data, metadata))
privateChannel.trigger('client-typing', { typing: true })
```

The Worker relays the event to every other subscriber of that channel, never to the sender. The
sender's own socket is excluded by socket id, exactly like a server trigger targeted with
`socket_id`.

- Events on public channels, on channels the socket is not subscribed to, and with data over
  10 KB get `pusher:error` code `4300`. The connection stays open.
- A presence channel adds a top-level `user_id` from the sender's presence subscription, which
  `pusher-js` hands to the listener as `metadata.user_id`. Private channels carry no `user_id`.
- One socket may send 10 client events per rolling 1000 ms. The 11th gets `pusher:error` code
  `4301` and is dropped; the connection stays open. Rejected frames do not count toward the
  limit. The limiter lives in the `AppHub` instance's memory, so a hibernation resets it.

## Batch publish

`POST /apps/:appId/batch_events` is signed exactly like `/events` and takes 1 to 10 events:

```js
await server.triggerBatch([
  { channel: 'private-room', name: 'greeting', data: { hello: 'world' } },
  { channel: 'public-smoke', name: 'greeting', data: { hello: 'again' } },
])
```

Each item carries a singular `channel`, not `channels`, and may set `socket_id` for exclusion.
The whole request is rejected with `400` before anything is broadcast when an event is invalid,
has no channel, uses a `private-encrypted-` channel, or carries a per-event `info` string. A
`data` field over 10 KB returns `413`. The successful response is `{}`.

## Channel queries

The Node SDK's `server.get({ path, params })` reaches three signed GET endpoints.

| Endpoint                                       | Params                     | Response                                |
| ---------------------------------------------- | -------------------------- | --------------------------------------- |
| `GET /apps/:appId/channels`                    | `filter_by_prefix`, `info` | `{ "channels": { "<name>": { ... } } }` |
| `GET /apps/:appId/channels/:channelName`       | `info`                     | `{ "occupied": boolean, ... }`          |
| `GET /apps/:appId/channels/:channelName/users` | none                       | `{ "users": [ { "id": "<userId>" } ] }` |

`info` is a comma-separated subset of `user_count` and `subscription_count`. `user_count` applies
only to presence channels, and in the list endpoint it needs a `filter_by_prefix` that selects
presence channels. `subscription_count` applies only to non-presence channels. Asking for an
attribute that does not apply to a channel in the response is a `400`, as are `cache` and any
unknown attribute name. Every count and every member comes from the live socket attachments in
the `AppHub`; `users` is deduped, sorted, and defined only for presence channels.

## API

- `GET /app/:key?protocol=7` upgrades to the `AppHub` Durable Object.
- `POST /apps/:appId/events` with a signed request broadcasts to channel subscribers.
- `POST /apps/:appId/batch_events` with a signed request broadcasts up to ten events.
- `GET /apps/:appId/channels`, `/channels/:channelName`, and `/channels/:channelName/users`
  answer channel queries.
- `GET /healthz` returns `{ "status": "ok" }`.

Supported in this version: public, private, and presence channels,
`pusher:connection_established`, `pusher:ping` / `pusher:pong`, `pusher:subscribe` /
`pusher:unsubscribe`, channel authorization generated by your application server, signed event
publishing with `socket_id` exclusion, client events on private and presence channels, batch
publish, and channel queries.

Not implemented: batch event `info`,
`POST /apps/:appId/users/:userId/terminate_connections` (it targets the user-auth id from
`pusher:signin`, and a presence `user_id` is a different identity), encrypted channels, cache
channels, and webhooks.
