#!/usr/bin/env node
/**
 * What a depush deployment costs on Cloudflare, against what the same workload
 * costs on Pusher Channels. Prices are list prices, checked 2026-10-27.
 *
 *   node scripts/cost-model.mjs          markdown tables
 *   node scripts/cost-model.mjs --json   the same numbers as JSON
 */

const MONTH_DAYS = 30
const MONTH_SECONDS = MONTH_DAYS * 24 * 60 * 60

/** Workers Paid list prices. https://developers.cloudflare.com/workers/platform/pricing/ */
const WORKERS = {
  /** Minimum monthly charge for the plan; it already includes the allotments below. */
  minimum: 5,
  includedRequests: 10e6,
  perRequest: 0.3 / 1e6,
  includedCpuMs: 30e6,
  perCpuMs: 0.02 / 1e6,
}

/** Durable Objects list prices. https://developers.cloudflare.com/durable-objects/platform/pricing/ */
const OBJECTS = {
  includedRequests: 1e6,
  perRequest: 0.15 / 1e6,
  /** Incoming WebSocket messages are billed at 20 messages to 1 request. */
  framesPerRequest: 20,
  includedGbSeconds: 400_000,
  perGbSecond: 12.5 / 1e6,
  gbPerObject: 0.128,
  includedRowsRead: 25e9,
  perRowRead: 0.001 / 1e6,
  includedRowsWritten: 50e6,
  perRowWritten: 1.0 / 1e6,
  includedGbMonth: 5,
  perGbMonth: 0.2,
}

/**
 * Vask list prices. https://vask.dev/pricing
 * Vask bills one broadcast per publish, however many subscribers receive it,
 * and includes client events in every plan.
 */
const VASK_PLANS = [
  { name: 'Free', price: 0, broadcasts: 500_000, connections: 100 },
  { name: 'Side', price: 10, broadcasts: 2_000_000, connections: 500 },
  { name: 'Indie', price: 20, broadcasts: 10_000_000, connections: 2_000 },
  { name: 'Team', price: 50, broadcasts: 30_000_000, connections: 5_000 },
  { name: 'Business', price: 100, broadcasts: 100_000_000, connections: 10_000 },
]

/**
 * Workers Free plan ceilings, per day.
 * https://developers.cloudflare.com/workers/platform/limits/
 * Exceeding one does not bill the overage: that operation starts failing.
 */
const FREE_PLAN = [
  ['billedDoRequests', 'DO requests', 100_000],
  ['rowsWritten', 'rows written', 100_000],
  ['workerRequests', 'worker requests', 100_000],
  ['gbSeconds', 'GB-s duration', 13_000],
]

/** Pusher Channels list prices. https://pusher.com/channels/pricing/ */
const PUSHER_PLANS = [
  { name: 'Sandbox', price: 0, messagesPerDay: 200_000, connections: 100 },
  { name: 'Startup', price: 49, messagesPerDay: 1_000_000, connections: 500 },
  { name: 'Pro', price: 99, messagesPerDay: 4_000_000, connections: 2_000 },
  { name: 'Business', price: 299, messagesPerDay: 10_000_000, connections: 5_000 },
  { name: 'Premium', price: 499, messagesPerDay: 20_000_000, connections: 10_000 },
  { name: 'Growth', price: 699, messagesPerDay: 40_000_000, connections: 15_000 },
  { name: 'Plus', price: 899, messagesPerDay: 60_000_000, connections: 20_000 },
  { name: 'Growth Plus', price: 1199, messagesPerDay: 90_000_000, connections: 30_000 },
]

/** What depush keeps per channel, from the README limits table. */
const HISTORY_MAX_EVENTS = 1000

/** Wall-clock one Durable Object call stays active, from Cloudflare's hibernation example. */
const MS_PER_DO_CALL = 10
/** Per-row storage cost: the payload plus the row and index overhead SQLite carries. */
const ROW_OVERHEAD_BYTES = 120

const DEFAULTS = {
  apps: 1,
  /** Sockets reconnecting per month each; one a day models mobile clients. */
  reconnectsPerConnection: 30,
  channelsPerPublish: 1,
  channelsPerConnection: 3,
  /** pusher-js pings after the activity timeout, which depush defaults to 120 seconds. */
  pingIntervalSeconds: 120,
  /** Signed HTTP calls that are not publishes: channel lists, info, history, presence. */
  queries: 0,
  historyQueries: 0,
  cacheSubscribes: 0,
  avgEventBytes: 200,
  cpuMsPerPublish: 3,
  /** Keepalives answered by the runtime through setWebSocketAutoResponse. */
  autoPong: false,
  /** App config held in the Worker instead of read from the Registry per request. */
  cachedConfig: false,
  /** The per-publish history row and its Channel run. */
  history: true,
  /** Publishes ride the app server's own socket instead of the signed HTTP API. */
  socketPublish: false,
}

/**
 * Six workloads, each written the way a team would describe its own traffic.
 * fanout is average subscribers per publish, which is what Pusher bills per delivery.
 */
const WORKLOADS = [
  {
    name: 'Side project',
    connections: 100,
    publishes: 30_000,
    fanout: 10,
    activeChannels: 20,
    channelsPerConnection: 2,
  },
  {
    name: 'Early SaaS',
    connections: 500,
    publishes: 300_000,
    fanout: 20,
    activeChannels: 200,
    channelsPerConnection: 2,
  },
  {
    name: 'Growing app',
    connections: 2_000,
    publishes: 1_200_000,
    fanout: 25,
    activeChannels: 1_000,
    channelsPerConnection: 3,
  },
  {
    name: 'Mid-market',
    connections: 5_000,
    publishes: 3_000_000,
    fanout: 50,
    activeChannels: 2_000,
    channelsPerConnection: 3,
  },
  {
    name: 'Large',
    connections: 10_000,
    publishes: 6_000_000,
    fanout: 90,
    activeChannels: 5_000,
    channelsPerConnection: 4,
  },
  {
    name: 'Very large',
    connections: 20_000,
    publishes: 10_000_000,
    fanout: 180,
    activeChannels: 10_000,
    channelsPerConnection: 5,
  },
]

function depush(workload) {
  const w = { ...DEFAULTS, ...workload }
  const upgrades = w.connections * w.reconnectsPerConnection
  const publishes = w.publishes
  const deliveries = publishes * w.fanout

  // A publish that rides the socket arrives as a frame and bills 1/20 of a
  // request. A publish over HTTP is a Worker request, a Registry read, a hub
  // run, and a channel run, because the signature check needs the app secret.
  const socketPublishes = w.socketPublish ? publishes : 0
  const httpPublishes = publishes - socketPublishes

  // Client to server frames: keepalives, one subscribe per channel per
  // connection, and any publish that rides the socket.
  const pings = w.autoPong ? 0 : (w.connections * MONTH_SECONDS) / w.pingIntervalSeconds
  const subscribeFrames = upgrades * w.channelsPerConnection
  const frames = pings + subscribeFrames + socketPublishes

  // Every publish runs the hub that owns the sockets. The Registry read and the
  // channel write are optional: a cached config and no history drop them.
  const registryCalls = upgrades + (w.cachedConfig ? 0 : httpPublishes + w.queries)
  const appHubRuns = upgrades * 2 + httpPublishes + w.queries + frames
  const channelCalls =
    (w.history ? publishes * w.channelsPerPublish : 0) + w.historyQueries + w.cacheSubscribes

  const billedDoRequests =
    upgrades * 2 +
    httpPublishes +
    w.queries +
    registryCalls +
    channelCalls +
    frames / OBJECTS.framesPerRequest

  const workerRequests = upgrades + httpPublishes + w.queries
  const cpuMs = workerRequests * w.cpuMsPerPublish

  // An object bills while it is active, capped at the month, so a busy hub stops
  // accruing once it is awake for all of wall-clock time.
  const activeSeconds = (calls, objects) =>
    objects * Math.min(MONTH_SECONDS, (calls / objects) * (MS_PER_DO_CALL / 1000))
  const gbSeconds =
    (activeSeconds(registryCalls, 1) +
      activeSeconds(appHubRuns, w.apps) +
      activeSeconds(channelCalls, w.activeChannels)) *
    OBJECTS.gbPerObject

  const eventsPerChannelPerDay = (publishes * w.channelsPerPublish) / MONTH_DAYS / w.activeChannels
  // Each publish inserts a history row, and once a channel is over its cap each
  // publish also deletes the oldest row. Deletes are billed as rows written.
  const churnPerPublish = eventsPerChannelPerDay > HISTORY_MAX_EVENTS ? 1 : 0.1
  const rowsWritten = w.history ? publishes * w.channelsPerPublish * (1 + churnPerPublish) : 0
  const rowsRead = registryCalls + w.historyQueries * 50 + w.cacheSubscribes + w.queries * 50

  const retainedRows = w.activeChannels * Math.min(HISTORY_MAX_EVENTS, eventsPerChannelPerDay)
  const gbStored = w.history ? (retainedRows * (w.avgEventBytes + ROW_OVERHEAD_BYTES)) / 1e9 : 0

  const cost = {
    workerRequests: Math.max(0, workerRequests - WORKERS.includedRequests) * WORKERS.perRequest,
    workerCpu: Math.max(0, cpuMs - WORKERS.includedCpuMs) * WORKERS.perCpuMs,
    doRequests: Math.max(0, billedDoRequests - OBJECTS.includedRequests) * OBJECTS.perRequest,
    doDuration: Math.max(0, gbSeconds - OBJECTS.includedGbSeconds) * OBJECTS.perGbSecond,
    rowsWritten: Math.max(0, rowsWritten - OBJECTS.includedRowsWritten) * OBJECTS.perRowWritten,
    rowsRead: Math.max(0, rowsRead - OBJECTS.includedRowsRead) * OBJECTS.perRowRead,
    storage: Math.max(0, gbStored - OBJECTS.includedGbMonth) * OBJECTS.perGbMonth,
  }

  return {
    name: w.name,
    connections: w.connections,
    publishes,
    deliveries,
    usage: {
      upgrades,
      incomingFrames: pings + subscribeFrames,
      socketPublishes,
      workerRequests,
      billedDoRequests,
      rowsWritten,
      rowsRead,
      gbSeconds,
      gbStored,
      cpuMs,
    },
    cost,
    total: WORKERS.minimum + Object.values(cost).reduce((sum, line) => sum + line, 0),
  }
}

/**
 * How much of each daily free ceiling a workload uses. The plan does not meter
 * and bill: it stops working when any one meter crosses its ceiling, so the
 * verdict is a fit, not a price.
 */
function freeHeadroom(usage) {
  const meters = FREE_PLAN.map(([key, label, ceiling]) => {
    const perDay = usage[key] / MONTH_DAYS
    return { label, ceiling, perDay, share: perDay / ceiling }
  })
  const over = meters.filter((meter) => meter.share > 1).sort((a, b) => b.share - a.share)
  return { meters, over, fits: over.length === 0 }
}

function vask(workload) {
  const plan = VASK_PLANS.find(
    (candidate) =>
      workload.publishes <= candidate.broadcasts && workload.connections <= candidate.connections,
  )
  return { plan: plan?.name ?? 'Quote', total: plan?.price ?? null }
}

/** Attaches the free-plan verdict to a priced row. */
function withFree(row) {
  return { ...row, depush: { ...row.depush, free: freeHeadroom(row.depush.usage) } }
}

function pusher(workload) {
  const deliveries = workload.publishes * workload.fanout
  // Pusher counts the publish itself and every delivery it fans out to.
  const messagesPerDay = (workload.publishes * (1 + workload.fanout)) / MONTH_DAYS
  const plan = PUSHER_PLANS.find(
    (candidate) =>
      messagesPerDay <= candidate.messagesPerDay && workload.connections <= candidate.connections,
  )
  return {
    deliveries,
    messagesPerDay,
    plan: plan?.name ?? 'Enterprise',
    total: plan?.price ?? null,
  }
}

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})
const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function compact(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return NUMBER.format(value)
}

function money(value) {
  return MONEY.format(value)
}

/**
 * Ops time is a real cost of self-hosting and it dwarfs the Cloudflare bill at
 * the low end. The headline table reports how many hours a month of maintenance
 * self-hosting can absorb before Pusher is the cheaper option.
 */
const OPS_HOURLY = 100

/** Columns are padded to the widest cell so the tables paste into the doc already formatted. */
function table(header, body) {
  const width = header.map((_, i) =>
    Math.max(header[i].length, ...body.map((cells) => cells[i].length)),
  )
  const row = (cells) => `| ${cells.map((cell, i) => cell.padStart(width[i])).join(' | ')} |`
  const rule = width.map((w) => `${'-'.repeat(w - 1)}:`)
  return [row(header), row(rule), ...body.map(row)].join('\n')
}

function headline(rows) {
  const header = [
    'Workload',
    'Sockets',
    'Publishes/mo',
    'Deliveries/mo',
    'Pusher',
    'Vask',
    'depush free',
    'depush paid',
    'Ops budget',
  ]
  const body = rows.map(({ depush: d, pusher: p, vask: k }) => [
    d.name,
    NUMBER.format(d.connections),
    compact(d.publishes),
    compact(d.deliveries),
    quote(p),
    quote(k),
    d.free.fits ? '$0.00' : 'over limit',
    money(d.total),
    opsBudget(d.total, [p.total, k.total]),
  ])
  return table(header, body)
}

/** A price with the tier it buys, so the table answers "on what plan" in place. */
function quote(service) {
  if (service.total === null) return 'quote'
  return `${money(service.total)} (${service.plan})`
}

/**
 * Maintenance the depush bill can absorb per month at $100 an hour before the
 * cheapest managed option beats self-hosting. The cheapest option is whichever
 * of Pusher and Vask prices lower for this workload.
 */
function opsBudget(depushTotal, managedTotals) {
  const cheapest = Math.min(...managedTotals.filter((total) => total !== null))
  if (!Number.isFinite(cheapest)) return '\u221e'
  const hours = (cheapest - depushTotal) / OPS_HOURLY
  if (hours <= 0) return 'none'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  return `${hours.toFixed(hours < 10 ? 1 : 0)} h`
}

function freePlan(rows) {
  const header = [
    'Workload',
    'DO req/day',
    'Rows written/day',
    'GB-s/day',
    'Worker req/day',
    'Free plan',
  ]
  const body = rows.map(({ depush: d }) => {
    const share = (label) =>
      `${Math.round(d.free.meters.find((meter) => meter.label === label).share * 100)}%`
    const verdict = d.free.fits
      ? 'fits'
      : 'over on ' +
        d.free.over.map((meter) => `${meter.label} ${meter.share.toFixed(1)}\u00d7`).join(', ')
    return [
      d.name,
      `${share('DO requests')} of 100k`,
      `${share('rows written')} of 100k`,
      `${share('GB-s duration')} of 13k`,
      `${share('worker requests')} of 100k`,
      verdict,
    ]
  })
  return table(header, body)
}

function usage(rows) {
  const header = ['Workload', 'Worker req', 'DO req billed', 'Rows written', 'GB-s', 'GB stored']
  const body = rows.map(({ depush: d }) => [
    d.name,
    compact(d.usage.workerRequests),
    compact(d.usage.billedDoRequests),
    compact(d.usage.rowsWritten),
    compact(d.usage.gbSeconds),
    d.usage.gbStored.toFixed(2),
  ])
  return table(header, body)
}

function breakdown(row) {
  const d = row.depush
  const lines = [
    ['Workers plan minimum', WORKERS.minimum, 'includes 10M requests and 30M CPU ms'],
    ['Worker requests', d.cost.workerRequests, `${compact(d.usage.workerRequests)} requests`],
    ['Worker CPU', d.cost.workerCpu, `${compact(d.usage.cpuMs)} CPU ms`],
    ['Durable Object requests', d.cost.doRequests, `${compact(d.usage.billedDoRequests)} billed`],
    ['Durable Object duration', d.cost.doDuration, `${compact(d.usage.gbSeconds)} GB-s`],
    ['SQLite rows written', d.cost.rowsWritten, `${compact(d.usage.rowsWritten)} rows`],
    ['SQLite rows read', d.cost.rowsRead, `${compact(d.usage.rowsRead)} rows`],
    ['SQLite storage', d.cost.storage, `${d.usage.gbStored.toFixed(2)} GB-month`],
  ]
  const body = lines.map(([label, value, note]) => [label, money(value), note])
  body.push(['Total', money(d.total), `${d.name}, Pusher at ${row.pusher.plan}`])
  return table(['Line', 'Monthly', 'Driven by'], body)
}

/**
 * Every lever available to the bill, one column each. The first five keep the
 * Pusher protocol; socket publish is the only one that gives it up.
 */
const VARIANTS = [
  { name: 'as built', options: {} },
  { name: 'runtime pong', options: { autoPong: true } },
  { name: 'cached config', options: { cachedConfig: true } },
  { name: 'no history', options: { history: false } },
  { name: 'all compatible', options: { autoPong: true, cachedConfig: true, history: false } },
  { name: 'socket publish', options: { socketPublish: true } },
  {
    name: 'everything',
    options: { autoPong: true, cachedConfig: true, history: false, socketPublish: true },
  },
]

function variantTable(rows) {
  const header = ['Workload', ...VARIANTS.map((variant) => variant.name)]
  const body = rows.map(({ workload, depush: d }) => [
    d.name,
    ...VARIANTS.map((variant) => money(depush({ ...workload, ...variant.options }).total)),
  ])
  return table(header, body)
}

/**
 * One publish rate and one socket count, with the audience per publish moving.
 * Pusher bills the publish plus every delivery, so its price tracks fan-out while
 * depush's tracks publishes and keepalives.
 */
const FANOUT = {
  name: 'Fan-out',
  connections: 500,
  publishes: 1_000_000,
  activeChannels: 500,
  channelsPerConnection: 2,
}

const FANOUT_STEPS = [1, 10, 50, 200, 1000]

function fanout(rows) {
  const header = ['Fan-out', 'Deliveries/mo', 'Pusher msgs/day', 'Pusher', 'Vask', 'depush']
  const body = rows.map(({ workload, depush: d, pusher: p, vask: k }) => [
    `${NUMBER.format(workload.fanout)}x`,
    compact(d.deliveries),
    compact(p.messagesPerDay),
    quote(p),
    quote(k),
    money(d.total),
  ])
  return table(header, body)
}

const fanoutRows = FANOUT_STEPS.map((fanout) => {
  const workload = { ...FANOUT, fanout }
  return { workload, depush: depush(workload), pusher: pusher(workload), vask: vask(workload) }
}).map(withFree)

const rows = WORKLOADS.map((workload) => ({
  workload,
  depush: depush(workload),
  pusher: pusher(workload),
  vask: vask(workload),
})).map(withFree)

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ workloads: rows, fanout: fanoutRows }, null, 2)}\n`)
} else {
  process.stdout.write(`### Workload cost\n\n${headline(rows)}\n\n`)
  process.stdout.write(`### What each lever buys\n\n${variantTable(rows)}\n\n`)
  process.stdout.write(`### Free plan headroom\n\n${freePlan(rows)}\n\n`)
  process.stdout.write(`### depush usage\n\n${usage(rows)}\n\n`)
  process.stdout.write('### Fan-out sensitivity (1M publishes/mo, 500 sockets)\n\n')
  process.stdout.write(`${fanout(fanoutRows)}\n\n`)
  process.stdout.write(`### Where the money goes (largest workload)\n\n${breakdown(rows.at(-1))}\n`)
}
