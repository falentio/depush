import { describe, expect, it } from 'vitest'
import { verifyChannelAuth } from '../src/auth'
import type { AppConfig } from '../src/config'
import { hmacHex } from '../src/signature'

const APP_ID = '3'
const APP_KEY = '278d425bdf160c739803'
const APP_SECRET = '7ad3773142a6692b25b8'
const SOCKET_ID = '1234.1234'
const PRESENCE_DATA = '{"user_id":10,"user_info":{"name":"Mr. Channels"}}'
const PRIVATE_SIGNATURE = '58df8b0c36d6982b82c3ecf6b4662e34fe8c25bba48f5369f135bf843651c3a4'
const PRESENCE_SIGNATURE = '31935e7d86dba64c2a90aed31fdc61869f9b22ba9d8863bba239c03ca481bc80'

const config: AppConfig = {
  appId: APP_ID,
  key: APP_KEY,
  secret: APP_SECRET,
  activityTimeout: 120,
  cacheTtlSeconds: 1800,
}

describe('verifyChannelAuth', () => {
  it('accepts the private auth worked vector', async () => {
    expect(
      await verifyChannelAuth(
        {
          channel: 'private-foobar',
          socketId: SOCKET_ID,
          auth: `${APP_KEY}:${PRIVATE_SIGNATURE}`,
          channelData: undefined,
        },
        config,
      ),
    ).toEqual({ ok: true, presence: null })
  })

  it('accepts the presence auth worked vector and parses channel_data', async () => {
    expect(
      await verifyChannelAuth(
        {
          channel: 'presence-foobar',
          socketId: SOCKET_ID,
          auth: `${APP_KEY}:${PRESENCE_SIGNATURE}`,
          channelData: PRESENCE_DATA,
        },
        config,
      ),
    ).toEqual({
      ok: true,
      presence: { userId: '10', userInfo: { name: 'Mr. Channels' } },
    })
  })

  it('rejects a tampered signature', async () => {
    const tampered = `${PRIVATE_SIGNATURE.slice(0, -1)}0`
    expect(
      await verifyChannelAuth(
        {
          channel: 'private-foobar',
          socketId: SOCKET_ID,
          auth: `${APP_KEY}:${tampered}`,
          channelData: undefined,
        },
        config,
      ),
    ).toEqual({ ok: false })
  })

  it('rejects a signature for another socket id', async () => {
    const signature = await hmacHex(APP_SECRET, `1234.1235:private-foobar`)
    expect(
      await verifyChannelAuth(
        {
          channel: 'private-foobar',
          socketId: SOCKET_ID,
          auth: `${APP_KEY}:${signature}`,
          channelData: undefined,
        },
        config,
      ),
    ).toEqual({ ok: false })
  })

  it('rejects missing auth and a mismatched app key', async () => {
    expect(
      await verifyChannelAuth(
        { channel: 'private-foobar', socketId: SOCKET_ID, auth: undefined, channelData: undefined },
        config,
      ),
    ).toEqual({ ok: false })
    expect(
      await verifyChannelAuth(
        {
          channel: 'private-foobar',
          socketId: SOCKET_ID,
          auth: `other-key:${PRIVATE_SIGNATURE}`,
          channelData: undefined,
        },
        config,
      ),
    ).toEqual({ ok: false })
  })

  it('rejects presence without channel_data or with an invalid user_id', async () => {
    const noData = await hmacHex(APP_SECRET, `${SOCKET_ID}:presence-foobar:`)
    expect(
      await verifyChannelAuth(
        {
          channel: 'presence-foobar',
          socketId: SOCKET_ID,
          auth: `${APP_KEY}:${noData}`,
          channelData: undefined,
        },
        config,
      ),
    ).toEqual({ ok: false })

    const badData = '{"user_id":null}'
    const badSignature = await hmacHex(APP_SECRET, `${SOCKET_ID}:presence-foobar:${badData}`)
    expect(
      await verifyChannelAuth(
        {
          channel: 'presence-foobar',
          socketId: SOCKET_ID,
          auth: `${APP_KEY}:${badSignature}`,
          channelData: badData,
        },
        config,
      ),
    ).toEqual({ ok: false })
  })

  it('accepts a string user_id and defaults missing user_info', async () => {
    const channelData = '{"user_id":"alice"}'
    const signature = await hmacHex(APP_SECRET, `${SOCKET_ID}:presence-foobar:${channelData}`)
    expect(
      await verifyChannelAuth(
        {
          channel: 'presence-foobar',
          socketId: SOCKET_ID,
          auth: `${APP_KEY}:${signature}`,
          channelData,
        },
        config,
      ),
    ).toEqual({ ok: true, presence: { userId: 'alice', userInfo: {} } })
  })
})
