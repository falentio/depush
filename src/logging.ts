import { env } from 'cloudflare:workers'
import {
  configureSync,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  isLogLevel,
} from '@logtape/logtape'

const configured: string = env.LOG_LEVEL
const level = isLogLevel(configured) ? configured : 'info'

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

if (configured !== level) log.root.warn('log_level_invalid', { value: configured })
log.root.info('ready', { level })
