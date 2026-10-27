declare module 'pusher' {
  export type PusherOptions = {
    appId: string
    key: string
    secret: string
    host?: string
    port?: number
    useTLS?: boolean
  }

  export type BatchEvent = {
    name: string
    channel: string
    data: unknown
  }

  export type RequestOptions = {
    path: string
    params?: Record<string, string>
  }

  export type PusherResponse = {
    status: number
    json(): Promise<unknown>
  }

  export default class Pusher {
    constructor(options: PusherOptions)
    trigger(channels: string | string[], event: string, data: unknown): Promise<PusherResponse>
    triggerBatch(batch: BatchEvent[]): Promise<PusherResponse>
    get(options: RequestOptions): Promise<PusherResponse>
  }
}
