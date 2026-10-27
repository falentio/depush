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

`pnpm compat` starts its own dev server on `127.0.0.1` (port 8787 when free, the next free port otherwise), backs up `.dev.vars`, writes test credentials, runs the checks, and restores it.

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

## API

- `GET /app/:key?protocol=7` upgrades to the `AppHub` Durable Object.
- `POST /apps/:appId/events` with a signed request broadcasts to channel subscribers.
- `GET /healthz` returns `{ "status": "ok" }`.

Supported in this version: public channels, `pusher:connection_established`, `pusher:ping` /
`pusher:pong`, `pusher:subscribe` / `pusher:unsubscribe`, and signed event publishing with
`socket_id` exclusion. Private, presence, and encrypted channels are rejected until their auth
landing.
