import * as v from 'valibot'

export const MAX_DATA_BYTES = 10 * 1024
export const MAX_CHANNELS = 100

export type Trigger = {
  name: string
  data: string
  channels: string[]
  socketId: string | undefined
}

export type TriggerResult =
  | { ok: true; trigger: Trigger }
  | { ok: false; status: 400 | 413; error: string }

const channelName = v.pipe(v.string(), v.minLength(1))
const eventName = v.pipe(v.string(), v.minLength(1), v.maxLength(200))
const socketId = v.pipe(v.string(), v.regex(/^\d+\.\d+$/))

const eventFields = {
  name: eventName,
  data: v.string(),
  socket_id: v.optional(socketId),
}

const triggerSchema = v.union([
  v.object({
    ...eventFields,
    channels: v.pipe(v.array(channelName), v.minLength(1), v.maxLength(MAX_CHANNELS)),
  }),
  v.object({ ...eventFields, channel: channelName }),
])

export function parseTrigger(body: Uint8Array): TriggerResult {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return invalid('Body must be JSON')
  }

  const parsed = v.safeParse(triggerSchema, json)
  if (!parsed.success) {
    return invalid('Invalid event payload')
  }

  if (new TextEncoder().encode(parsed.output.data).length > MAX_DATA_BYTES) {
    return { ok: false, status: 413, error: 'Event data exceeds 10KB' }
  }

  const event = parsed.output
  return {
    ok: true,
    trigger: {
      name: event.name,
      data: event.data,
      channels: 'channels' in event ? event.channels : [event.channel],
      socketId: event.socket_id,
    },
  }
}

function invalid(error: string): TriggerResult {
  return { ok: false, status: 400, error }
}
