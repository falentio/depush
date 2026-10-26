import { DurableObject } from 'cloudflare:workers'
import * as v from 'valibot'
import type { DeploymentEvent } from '../domain/deployment'
import { deploymentEventSchema } from '../domain/deployment'

const STATE_KEY = 'state'

const channelStateSchema = v.object({
  sequence: v.pipe(v.number(), v.integer(), v.minValue(0)),
  latest: v.nullable(deploymentEventSchema),
})

export type ChannelState = v.InferOutput<typeof channelStateSchema>

export type PublishedState = {
  sequence: number
  latest: DeploymentEvent
}

export function appChannel(env: Env, appId: string) {
  return env.APP_CHANNEL.get(env.APP_CHANNEL.idFromName(appId))
}

export class AppChannel extends DurableObject<Env> {
  async publish(input: unknown): Promise<PublishedState> {
    const latest = v.parse(deploymentEventSchema, input)
    const current = await this.snapshot()
    const next = { sequence: current.sequence + 1, latest }
    await this.ctx.storage.put(STATE_KEY, next)

    const message = JSON.stringify({ type: 'deployment', ...next })
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message)
      } catch {
        // A socket closed between listing and sending needs no reply.
      }
    }

    return next
  }

  async snapshot(): Promise<ChannelState> {
    const stored = await this.ctx.storage.get(STATE_KEY)
    if (stored === undefined) return { sequence: 0, latest: null }

    return v.parse(channelStateSchema, stored)
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 426 })
    }

    const pair = new WebSocketPair()
    const server = pair[1]
    this.ctx.acceptWebSocket(server)

    const state = await this.snapshot()
    server.send(JSON.stringify({ type: 'snapshot', ...state }))

    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
  }

  override webSocketClose(socket: WebSocket): void {
    socket.close()
  }
}
