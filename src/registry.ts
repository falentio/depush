import { DurableObject } from 'cloudflare:workers'
import type { CleanedWhere, CustomAdapter, Where } from '@better-auth/core/db/adapter'
import { createAdapterFactory } from '@better-auth/core/db/adapter'

export type AppRecord = {
  id: string
  key: string
  name: string
  created_at: number
}

export type NewAppRecord = AppRecord & { secret: string }

export type Settings = { signup_enabled: boolean }

export function isAdmin(role: string | null): boolean {
  return role === 'admin'
}

export type SignUpDecision = { allowed: true; admin: boolean } | { allowed: false }

type Row = Record<string, unknown>
type ColumnValue = string | number | null

/** One storage operation, named after the adapter method that issues it. */
export type AuthQuery =
  | { kind: 'insert'; model: string; data: Row }
  | { kind: 'update'; model: string; where: CleanedWhere[]; update: Row }
  | { kind: 'updateMany'; model: string; where: CleanedWhere[]; update: Row }
  | { kind: 'findOne'; model: string; where: CleanedWhere[] }
  | {
      kind: 'findMany'
      model: string
      where?: CleanedWhere[] | undefined
      limit: number
      sortBy?: { field: string; direction: 'asc' | 'desc' } | undefined
      offset?: number | undefined
    }
  | { kind: 'delete'; model: string; where: CleanedWhere[] }
  | { kind: 'deleteMany'; model: string; where: CleanedWhere[] }
  | { kind: 'count'; model: string; where?: CleanedWhere[] | undefined }

export type AuthQueryResult = Row | Row[] | number | null

const TABLES = ['user', 'session', 'account', 'verification', 'settings', 'app'] as const
type Table = (typeof TABLES)[number]

const CREATE_AUTH_TABLES = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    createdAt INTEGER,
    updatedAt INTEGER,
    role TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    expiresAt INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    createdAt INTEGER,
    updatedAt INTEGER,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt INTEGER,
    refreshTokenExpiresAt INTEGER,
    scope TEXT,
    password TEXT,
    createdAt INTEGER,
    updatedAt INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt INTEGER,
    createdAt INTEGER,
    updatedAt INTEGER
  )`,
]

const APP_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const APP_ID_LENGTH = 8
const APP_ID_ATTEMPTS = 5
const HEX_BYTES = 16

export function isTable(name: string): name is Table {
  return TABLES.some((table) => table === name)
}

export function randomId(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

export function randomHex(byteLength: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(byteLength)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function toColumnValue(value: Where['value']): ColumnValue | ColumnValue[] {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

function toColumn(data: Row): { columns: string[]; values: ColumnValue[] } {
  const columns = Object.keys(data)
  return {
    columns,
    values: columns.map((column) => toColumnValue(data[column] as Where['value']) as ColumnValue),
  }
}

const COMPARISONS = { lt: '<', lte: '<=', gt: '>', gte: '>=' } as const

type Like = 'contains' | 'starts_with' | 'ends_with'

function likeValue(operator: Like, value: ColumnValue): ColumnValue {
  if (typeof value !== 'string') return value
  if (operator === 'contains') return `%${value}%`
  if (operator === 'starts_with') return `${value}%`
  return `%${value}`
}

type Clause = { sql: string; values: ColumnValue[] }

/**
 * better-auth hands the adapter the fields that survive a `WHERE`, so the
 * clause is built from that list instead of from user input.
 */
function whereClause(where: CleanedWhere[]): Clause {
  const parts: string[] = []
  const values: ColumnValue[] = []

  for (const clause of where) {
    const column = `"${clause.field}"`
    const operator = clause.operator

    if (operator === 'eq' || operator === 'ne') {
      const negated = operator === 'ne'
      if (clause.value === null) {
        parts.push(`${column} IS ${negated ? 'NOT ' : ''}NULL`)
        continue
      }
      parts.push(`${column} ${negated ? '!=' : '='} ?`)
      values.push(toColumnValue(clause.value) as ColumnValue)
      continue
    }

    if (operator === 'in' || operator === 'not_in') {
      const list = Array.isArray(clause.value) ? clause.value : [clause.value]
      if (list.length === 0) {
        parts.push(operator === 'in' ? '0 = 1' : '1 = 1')
        continue
      }
      const negation = operator === 'not_in' ? 'NOT IN' : 'IN'
      parts.push(`${column} ${negation} (${placeholders(list.length)})`)
      values.push(...list.map((value) => toColumnValue(value) as ColumnValue))
      continue
    }

    if (operator === 'lt' || operator === 'lte' || operator === 'gt' || operator === 'gte') {
      parts.push(`${column} ${COMPARISONS[operator]} ?`)
      values.push(toColumnValue(clause.value) as ColumnValue)
      continue
    }

    if (operator === 'contains' || operator === 'starts_with' || operator === 'ends_with') {
      parts.push(`${column} LIKE ?`)
      values.push(likeValue(operator, toColumnValue(clause.value) as ColumnValue))
      continue
    }

    throw new Error(`Registry adapter cannot translate "${operator}" on ${clause.field}`)
  }

  const sql = parts
    .map((part, index) =>
      index === 0 ? part : `${where[index - 1]?.connector === 'OR' ? 'OR' : 'AND'} ${part}`,
    )
    .join(' ')

  return { sql, values }
}

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of CREATE_AUTH_TABLES) ctx.storage.sql.exec(statement)
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          signup_enabled INTEGER NOT NULL
        )`,
      )
      ctx.storage.sql.exec('INSERT OR IGNORE INTO settings (id, signup_enabled) VALUES (1, 1)')
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS app (
          app_id TEXT PRIMARY KEY,
          key TEXT NOT NULL UNIQUE,
          secret TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      )
    })
  }

  /**
   * better-auth counts a sign-up before inserting the row, so the admin
   * decision is made here. The DO runs one request at a time, which makes the
   * count and the insert the same decision.
   */
  signUpDecision(): SignUpDecision {
    if (this.userCount() === 0) return { allowed: true, admin: true }
    return this.settings().signup_enabled ? { allowed: true, admin: false } : { allowed: false }
  }

  userRole(userId: string): string | null {
    const row = this.sql.exec('SELECT role FROM user WHERE id = ?', userId).toArray()[0]
    return row === undefined ? null : String(row.role ?? '')
  }

  settings(): Settings {
    const row = this.sql.exec('SELECT signup_enabled FROM settings WHERE id = 1').one()
    return { signup_enabled: Number(row.signup_enabled) === 1 }
  }

  updateSettings(input: Settings): Settings {
    this.sql.exec(
      'UPDATE settings SET signup_enabled = ? WHERE id = 1',
      input.signup_enabled ? 1 : 0,
    )
    return this.settings()
  }

  appByKey(key: string): NewAppRecord | null {
    return this.appRow('key = ?', key)
  }

  appById(appId: string): NewAppRecord | null {
    return this.appRow('app_id = ?', appId)
  }

  apps(): AppRecord[] {
    return this.sql
      .exec('SELECT app_id, key, name, created_at FROM app ORDER BY created_at, app_id')
      .toArray()
      .map(toAppRecord)
  }

  createApp(name: string): NewAppRecord | null {
    const secret = randomHex(HEX_BYTES)
    for (let attempt = 0; attempt < APP_ID_ATTEMPTS; attempt += 1) {
      const record: NewAppRecord = {
        id: randomId(APP_ID_LENGTH, APP_ID_ALPHABET),
        key: randomHex(HEX_BYTES),
        secret,
        name,
        created_at: Date.now(),
      }
      if (this.appById(record.id) !== null || this.appByKey(record.key) !== null) continue
      this.sql.exec(
        'INSERT INTO app (app_id, key, secret, name, created_at) VALUES (?, ?, ?, ?, ?)',
        record.id,
        record.key,
        record.secret,
        record.name,
        record.created_at,
      )
      return record
    }
    return null
  }

  deleteApp(appId: string): boolean {
    if (this.appById(appId) === null) return false
    this.sql.exec('DELETE FROM app WHERE app_id = ?', appId)
    return true
  }

  /**
   * The storage half of better-auth's adapter. It returns rows, not a live
   * adapter: a function cannot cross the RPC boundary into the Worker, where
   * the adapter factory runs.
   */
  async authQuery(input: AuthQuery): Promise<AuthQueryResult> {
    const table = this.tableFor(input.model)
    switch (input.kind) {
      case 'insert': {
        const { columns, values } = toColumn(input.data)
        if (columns.length === 0) throw new Error(`Registry adapter got an empty ${table} row`)
        this.sql.exec(
          `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${placeholders(columns.length)})`,
          ...values,
        )
        return this.selectOne(table, rowWhere(input.data))
      }
      case 'update': {
        const { columns, values } = toColumn(input.update)
        if (columns.length === 0) return null
        const clause = whereClause(input.where)
        this.sql.exec(
          `UPDATE ${table} SET ${columns.map((column) => `"${column}" = ?`).join(', ')} WHERE ${clause.sql}`,
          ...values,
          ...clause.values,
        )
        return this.selectOne(table, input.where)
      }
      case 'updateMany': {
        const { columns, values } = toColumn(input.update)
        if (columns.length === 0) return 0
        const affected = this.countRows(table, input.where)
        const clause = whereClause(input.where)
        this.sql.exec(
          `UPDATE ${table} SET ${columns.map((column) => `"${column}" = ?`).join(', ')} WHERE ${clause.sql}`,
          ...values,
          ...clause.values,
        )
        return affected
      }
      case 'findOne':
        return this.selectOne(table, input.where)
      case 'findMany': {
        const where = input.where ?? []
        const order =
          input.sortBy === undefined
            ? ''
            : ` ORDER BY "${input.sortBy.field}" ${input.sortBy.direction === 'asc' ? 'ASC' : 'DESC'}`
        const window = ` LIMIT ${input.limit}${input.offset === undefined ? '' : ` OFFSET ${input.offset}`}`
        if (where.length === 0) {
          return this.sql.exec(`SELECT * FROM ${table}${order}${window}`).toArray()
        }
        const clause = whereClause(where)
        return this.sql
          .exec(`SELECT * FROM ${table} WHERE ${clause.sql}${order}${window}`, ...clause.values)
          .toArray()
      }
      case 'delete': {
        const clause = whereClause(input.where)
        this.sql.exec(`DELETE FROM ${table} WHERE ${clause.sql}`, ...clause.values)
        return null
      }
      case 'deleteMany': {
        const affected = this.countRows(table, input.where)
        const clause = whereClause(input.where)
        this.sql.exec(`DELETE FROM ${table} WHERE ${clause.sql}`, ...clause.values)
        return affected
      }
      case 'count':
        return this.countRows(table, input.where ?? [])
    }
  }

  private get sql() {
    return this.ctx.storage.sql
  }

  private userCount(): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS total FROM user').one().total)
  }

  private appRow(condition: string, value: string): NewAppRecord | null {
    const row = this.sql
      .exec(`SELECT app_id, key, secret, name, created_at FROM app WHERE ${condition}`, value)
      .toArray()[0]
    return row === undefined ? null : { ...toAppRecord(row), secret: String(row.secret) }
  }

  private tableFor(model: string): Table {
    if (!isTable(model)) throw new Error(`Unknown registry table: ${model}`)
    return model
  }

  private selectOne(table: Table, where: CleanedWhere[]): Row | null {
    const clause = whereClause(where)
    const row = this.sql
      .exec(`SELECT * FROM ${table} WHERE ${clause.sql} LIMIT 1`, ...clause.values)
      .toArray()[0]
    return row ?? null
  }

  private countRows(table: Table, where: CleanedWhere[]): number {
    if (where.length === 0) {
      return Number(this.sql.exec(`SELECT COUNT(*) AS total FROM ${table}`).one().total)
    }
    const clause = whereClause(where)
    const row = this.sql
      .exec(`SELECT COUNT(*) AS total FROM ${table} WHERE ${clause.sql}`, ...clause.values)
      .one()
    return Number(row.total)
  }
}

function rowWhere(row: Row): CleanedWhere[] {
  return Object.entries(row).flatMap(([field, value]) =>
    value === null
      ? []
      : [
          {
            field,
            value: value as Where['value'],
            operator: 'eq' as const,
            connector: 'AND' as const,
            mode: 'sensitive' as const,
          },
        ],
  )
}

function toAppRecord(row: Row): AppRecord {
  return {
    id: String(row.app_id),
    key: String(row.key),
    name: String(row.name),
    created_at: Number(row.created_at),
  }
}
