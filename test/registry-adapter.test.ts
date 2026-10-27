import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { AppBindings } from '../src/env'
import type { AuthQuery, AuthQueryResult } from '../src/registry'
import type { RegistryStub } from '../src/session'
import { createAuth } from '../src/session'

const ORIGIN = 'http://depush.test'

/** A Registry object nobody else reaches, so each test starts on empty tables. */
function freshRegistry() {
  return env.REGISTRY.get(env.REGISTRY.idFromName(`adapter-${crypto.randomUUID()}`))
}

function user(email: string, name: string, id = crypto.randomUUID()): AuthQuery {
  return {
    kind: 'insert',
    model: 'user',
    data: { id, name, email, emailVerified: 0, createdAt: 1, updatedAt: 1 },
  }
}

function emailIs(value: string, connector: 'AND' | 'OR') {
  return { field: 'email', value, operator: 'eq' as const, connector, mode: 'sensitive' as const }
}

async function ids(rows: AuthQueryResult): Promise<string[]> {
  if (!Array.isArray(rows)) throw new Error('expected rows')
  return rows.map((row) => String(row.id)).sort()
}

describe('the adapter query translator', () => {
  it('joins each clause with its own connector', async () => {
    const registry = freshRegistry()
    await registry.authQuery(user('a@example.test', 'needle'))

    const rows = await registry.authQuery({
      kind: 'findMany',
      model: 'user',
      limit: 10,
      where: [emailIs('a@example.test', 'OR'), emailIs('nomatch@example.test', 'AND')],
    })

    expect(rows).toEqual([])
  })

  it('folds a mixed connector list left to right', async () => {
    const registry = freshRegistry()
    await registry.authQuery(user('x@example.test', 'a', 'first'))
    await registry.authQuery(user('y@example.test', 'a', 'second'))
    await registry.authQuery(user('z@example.test', 'b', 'third'))

    const rows = await registry.authQuery({
      kind: 'findMany',
      model: 'user',
      limit: 10,
      where: [
        { field: 'name', value: 'a', operator: 'eq', connector: 'AND', mode: 'sensitive' },
        emailIs('x@example.test', 'OR'),
        emailIs('y@example.test', 'AND'),
      ],
    })

    expect(await ids(rows)).toEqual(['second'])
  })

  it('drops an undefined field so the inserted row is returned', async () => {
    const registry = freshRegistry()
    const inserted = await registry.authQuery({
      kind: 'insert',
      model: 'user',
      data: {
        id: 'undefined-image',
        name: 'undefined image',
        email: 'b@example.test',
        emailVerified: 0,
        image: undefined,
        createdAt: 1,
        updatedAt: 1,
      },
    })

    expect(inserted).toMatchObject({ id: 'undefined-image', image: null })

    const found = await registry.authQuery({
      kind: 'findOne',
      model: 'user',
      where: [
        {
          field: 'id',
          value: 'undefined-image',
          operator: 'eq',
          connector: 'AND',
          mode: 'sensitive',
        },
      ],
    })
    expect(found).toMatchObject({ id: 'undefined-image' })
  })
})

describe('the adapter result narrowing', () => {
  it('throws instead of reporting a count when the DO answers with a row', async () => {
    const registry = freshRegistry()
    const wrongShape = {
      authQuery: (query: AuthQuery) =>
        query.kind === 'count' || query.kind === 'updateMany' || query.kind === 'deleteMany'
          ? Promise.resolve(null)
          : registry.authQuery(query),
    } as unknown as RegistryStub

    const auth = createAuth(
      wrongShape,
      env as AppBindings,
      new Request(`${ORIGIN}/api/auth/get-session`),
    )
    const { adapter } = await auth.$context

    await expect(
      adapter.updateMany({ model: 'session', where: [], update: { token: 'x' } }),
    ).rejects.toThrow('Registry adapter expected a count')
    await expect(adapter.count({ model: 'session', where: [] })).rejects.toThrow(
      'Registry adapter expected a count',
    )
  })
})
