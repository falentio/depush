<img src="assets/icon.svg" width="64" height="64" alt="">

# depush

Track deployments for each app, with a live deployment feed per app.

The API runs on Cloudflare Workers with Hono for routing, Drizzle over D1 for storage and
migrations, Valibot for validation, and one SQLite-backed Durable Object per app for live
state and WebSockets.

## Quickstart

Node 24 and pnpm are required.

```sh
pnpm install
pnpm db:migrate:local
pnpm dev
```

The dev server listens on `http://localhost:5173` by default and runs the Worker runtime through
the Cloudflare Vite plugin.

```sh
curl http://localhost:5173/health
curl -X POST http://localhost:5173/apps \
  -H 'content-type: application/json' \
  -d '{"name":"web"}'
```

## Commands

| Command                  | What it does                                             |
| ------------------------ | -------------------------------------------------------- |
| `pnpm dev`               | Start the Vite dev server with the Worker runtime.       |
| `pnpm build`             | Build the Worker for production.                         |
| `pnpm preview`           | Serve the production build locally.                      |
| `pnpm deploy`            | Build, then deploy with Wrangler.                        |
| `pnpm test`              | Run the Vitest suite inside workerd.                     |
| `pnpm test:watch`        | Rerun tests on change.                                   |
| `pnpm typecheck`         | Type-check with `tsc --noEmit`.                          |
| `pnpm check`             | Run the Biome lint and format checks.                    |
| `pnpm lint`              | Run Biome lint only.                                     |
| `pnpm format`            | Format with Biome.                                       |
| `pnpm cf-typegen`        | Regenerate `worker-configuration.d.ts`.                  |
| `pnpm db:generate`       | Generate a D1 migration from `src/db/schema.ts`.         |
| `pnpm db:migrate:local`  | Apply `drizzle/` migrations to the local D1 database.    |
| `pnpm db:migrate:remote` | Apply `drizzle/` migrations to the deployed D1 database. |

Run `pnpm cf-typegen` after changing `wrangler.jsonc`. It regenerates the binding types,
including `APP_CHANNEL` as `DurableObjectNamespace<AppChannel>`.

## Request flow

```text
request
└── Hono app                                  src/index.ts
    ├── error handlers                        ApiError -> one JSON envelope
    ├── GET /health                           SELECT 1 through D1
    └── /apps
        ├── appsRoutes                        GET /, POST /
        ├── deploymentRoutes                  GET, POST /:appId/deployments
        │                                     PATCH /:appId/deployments/:deploymentId
        └── liveRoutes                        GET /:appId/live, GET /:appId/live/ws
            │
            ├── validation                    src/http/validation.ts
            │   ├── vValidator                JSON body and query strings
            │   └── parseId                   path ids
            ├── data                          src/data/*.ts
            │   ├── apps                      createApp, listApps, requireApp
            │   └── deployments               createDeployment, listDeployments,
            │                                 transitionDeployment
            ├── db                            src/db
            │   ├── schema.ts                 tables, CHECK, index
            │   └── client.ts                 drizzle(D1) -> Database
            └── live channel                  src/durable/app-channel.ts
                ├── publish                   sequence + latest, broadcast
                └── snapshot                  current live state
```

The Drizzle schema in `src/db/schema.ts` maps snake_case columns to camelCase fields. Every
database row is parsed with Valibot before it becomes a domain value, so no row shape is
cast.

## Data model

`apps` stores one row per app. `deployments` stores the history and references `apps` with
`ON DELETE CASCADE`. Both tables live in `src/db/schema.ts`; `drizzle-kit` generates
`drizzle/0000_init.sql` from them, and Wrangler applies that SQL to D1. The index `deployments_by_app(app_id, created_at DESC, id DESC)`
serves the newest-first list and the `(created_at, id)` cursor.

A deployment has a closed status set and a fixed transition table:

```text
queued    -> building, failed
building  -> ready, failed
ready     -> (terminal)
failed    -> (terminal)
```

`DEPLOYMENT_TRANSITIONS` in `src/domain/deployment.ts` encodes the table, and the type
checker rejects a status that has no entry. Illegal transitions return `409` with
`details: { from, to }`. The update is conditional on the current status, so two racing
patches cannot both win.

Timestamps come from SQLite:
`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`. Deployment ids are supplied by the client or
generated with `crypto.randomUUID()`. Replaying an existing id returns `200` with the stored
row and does not insert a second one; reusing an id under a different app returns `409`.

Pagination uses an opaque cursor over `(created_at, id)`. `limit` defaults to 50 and accepts
1 to 100. `nextCursor` is present only when another row exists.

## Schema changes

Change a table in `src/db/schema.ts`, then generate and apply a migration:

```sh
pnpm db:generate
pnpm db:migrate:local
```

Commit the generated `drizzle/` directory, including `meta/`. Wrangler applies the SQL files
in order and records them in `d1_migrations`. Run `pnpm db:migrate:remote` for the deployed
database.

## HTTP API

| Method  | Path                                     | Result                                                                     |
| ------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `GET`   | `/health`                                | `{ "status": "ok", "db": "up" }`                                           |
| `GET`   | `/apps`                                  | `{ "apps": App[] }`, newest first                                          |
| `POST`  | `/apps`                                  | `201 { "app": App }`, body `{ "name": string }`                            |
| `GET`   | `/apps/:appId/deployments`               | `{ "deployments": Deployment[], "nextCursor": string \| null }`            |
| `POST`  | `/apps/:appId/deployments`               | `201` on insert, `200` on replay, body `{ "commitSha", "status"?, "id"? }` |
| `PATCH` | `/apps/:appId/deployments/:deploymentId` | `200 { "deployment": Deployment }`, body `{ "status" }`                    |
| `GET`   | `/apps/:appId/live`                      | `{ "live": { "sequence", "latest" } }`                                     |
| `GET`   | `/apps/:appId/live/ws`                   | `101` WebSocket upgrade                                                    |

Errors share one envelope:

```json
{ "error": { "code": "validation", "message": "Invalid request", "details": { "issues": [] } } }
```

Codes map to `400` for `validation`, `404` for `not_found`, `409` for `conflict`, and `500`
for `internal`. A server error logs the cause and returns the same envelope without the
original message.

## Live channel

Each app maps to one `AppChannel` Durable Object, named by the app id. The object stores
`{ sequence, latest }` under the key `"state"` and is the only writer for that app's live
state. `sequence` is a logical clock: it increments on every publish, including a replayed
create, so it is not derived from the deployment count.

Every create and every successful transition publishes `{ id, status, commitSha, at }`.
The object broadcasts `{ "type": "deployment", ...state }` to all hibernatable WebSockets.
A new socket receives `{ "type": "snapshot", ...state }` on connect. Sending `ping` returns
`{ "type": "pong" }`.

Check a socket by hand with `wscat`:

```sh
npx wscat -c ws://localhost:5173/apps/<appId>/live/ws
```

Creating a deployment from another terminal sends a `deployment` frame to the open socket.
A request without `Upgrade: websocket` gets `426`.

## Tests

`pnpm test` runs inside workerd through `@cloudflare/vitest-plugin`. Each test gets isolated
storage, so no cleanup is needed. `test/apply-migrations.ts` applies `drizzle/` to the
test D1 database before the suite runs. Integration tests call the Worker through
`exports.default.fetch`; only test setup touches `env.DB` directly.

## Deploy

1. Create the D1 database:

   ```sh
   pnpm exec wrangler d1 create depush
   ```

2. Put the returned `database_id` into `wrangler.jsonc` in place of the placeholder.

3. Apply the migrations to the remote database:

   ```sh
   pnpm db:migrate:remote
   ```

4. Deploy:

   ```sh
   pnpm deploy
   ```

The Durable Object migration in `wrangler.jsonc` creates `AppChannel` as a SQLite-backed
class on the first deploy. Changing an existing class requires a new migration tag.

Authentication is intentionally absent. Every route is public. Put Cloudflare Access or
another gateway in front of the Worker before exposing it.
