import type { CleanedWhere, CustomAdapter } from '@better-auth/core/db/adapter'
import { createAdapterFactory } from '@better-auth/core/db/adapter'
import { APIError } from 'better-auth/api'
import { betterAuth } from 'better-auth/minimal'
import type { AppBindings } from './env'
import { log } from './logging'
import type { AuthQuery, AuthQueryResult, Registry } from './registry'

export type RegistryStub = DurableObjectStub<Registry>

type Row = Record<string, unknown>

/**
 * better-auth runs against the Registry Durable Object. The DO does the SQL and
 * this factory only translates adapter calls into queries, because a function
 * cannot cross the RPC boundary.
 */
export function createAuth(registry: RegistryStub, env: AppBindings, request: Request) {
  const baseURL = env.BETTER_AUTH_URL ?? new URL(request.url).origin
  return betterAuth({
    secret: requireSecret(env),
    baseURL,
    basePath: '/api/auth',
    database: registryAdapter(registry),
    trustedOrigins: [baseURL],
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    user: {
      additionalFields: {
        role: { type: 'string', required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (!(await registry.signUpAllowed())) {
              log.admin.info('signup_refused')
              throw new APIError('FORBIDDEN', { message: 'Sign-up is disabled' })
            }
          },
        },
      },
    },
  })
}

function registryAdapter(registry: RegistryStub) {
  const run = (query: AuthQuery) => registry.authQuery(query)

  return createAdapterFactory({
    config: {
      adapterId: 'registry',
      supportsDates: false,
      supportsJSON: false,
      transaction: false,
    },
    adapter: ({ getModelName }) => ({
      create: (async ({ model, data }: { model: string; data: Row }) =>
        asRow(
          await run({ kind: 'insert', model: getModelName(model), data }),
        )) as CustomAdapter['create'],
      update: (async ({
        model,
        where,
        update,
      }: {
        model: string
        where: CleanedWhere[]
        update: Row
      }) =>
        asRowOrNull(
          await run({ kind: 'update', model: getModelName(model), where, update }),
        )) as CustomAdapter['update'],
      updateMany: async ({ model, where, update }) =>
        asCount(await run({ kind: 'updateMany', model: getModelName(model), where, update })),
      findOne: (async ({ model, where }: { model: string; where: CleanedWhere[] }) =>
        asRowOrNull(
          await run({ kind: 'findOne', model: getModelName(model), where }),
        )) as CustomAdapter['findOne'],
      findMany: (async ({
        model,
        where,
        limit,
        sortBy,
        offset,
      }: {
        model: string
        where?: CleanedWhere[] | undefined
        limit: number
        sortBy?: { field: string; direction: 'asc' | 'desc' } | undefined
        offset?: number | undefined
      }) =>
        asRows(
          await run({ kind: 'findMany', model: getModelName(model), where, limit, sortBy, offset }),
        )) as CustomAdapter['findMany'],
      delete: async ({ model, where }) => {
        await run({ kind: 'delete', model: getModelName(model), where })
      },
      deleteMany: async ({ model, where }) =>
        asCount(await run({ kind: 'deleteMany', model: getModelName(model), where })),
      count: async ({ model, where }) =>
        asCount(await run({ kind: 'count', model: getModelName(model), where })),
    }),
  })
}

/**
 * better-auth types adapter rows generically (`<T extends Record<string, any>>`)
 * while the DO answers with a row set fixed by its schema. These three narrow
 * the result once, at the adapter boundary, so no caller has to.
 */
function asRow(value: AuthQueryResult): Row {
  if (value === null || Array.isArray(value) || typeof value === 'number') {
    throw new Error('Registry adapter expected one row')
  }
  return value
}

function asRowOrNull(value: AuthQueryResult): Row | null {
  if (value === null) return null
  return asRow(value)
}

function asRows(value: AuthQueryResult): Row[] {
  if (!Array.isArray(value)) throw new Error('Registry adapter expected rows')
  return value
}

function asCount(value: AuthQueryResult): number {
  if (typeof value !== 'number') throw new Error('Registry adapter expected a count')
  return value
}

function requireSecret(env: AppBindings): string {
  if (env.BETTER_AUTH_SECRET === undefined || env.BETTER_AUTH_SECRET === '') {
    throw new Error('BETTER_AUTH_SECRET is not set')
  }
  return env.BETTER_AUTH_SECRET
}
