import { env } from 'cloudflare:workers'
import {
  configureSync,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  isLogLevel,
} from '@logtape/logtape'

const level = isLogLevel(env.LOG_LEVEL) ? env.LOG_LEVEL : 'info'

configureSync({
  sinks: { console: getConsoleSink({ formatter: getJsonLinesFormatter() }) },
  loggers: [
    { category: ['depush'], lowestLevel: level, sinks: ['console'] },
    { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
  ],
})

/**
 * Every message is a stable token and the variables ride in the properties,
 * so a grep finds one event kind.
 */
export const log = {
  root: getLogger(['depush']),
  request: getLogger(['depush', 'request']),
  admin: getLogger(['depush', 'admin']),
  hub: getLogger(['depush', 'hub']),
  channel: getLogger(['depush', 'channel']),
}

log.root.info('ready', { level })
