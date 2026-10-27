import { describe, expect, it } from 'vitest'
import type { SocketState } from '../src/hub'
import { collectPresenceMembers } from '../src/hub'

const alice: SocketState = {
  socketId: '1.1',
  subscriptions: [
    { channel: 'presence-room', presence: { userId: 'alice', userInfo: { name: 'Alice' } } },
  ],
}

const aliceSecondSocket: SocketState = {
  socketId: '1.2',
  subscriptions: [
    { channel: 'presence-room', presence: { userId: 'alice', userInfo: { name: 'Alice' } } },
  ],
}

const bob: SocketState = {
  socketId: '2.1',
  subscriptions: [
    { channel: 'presence-room', presence: { userId: 'bob', userInfo: { name: 'Bob' } } },
  ],
}

const publicOnly: SocketState = {
  socketId: '3.1',
  subscriptions: [{ channel: 'public-room' }],
}

describe('collectPresenceMembers', () => {
  it('dedupes members by user across sockets', () => {
    expect(
      collectPresenceMembers([alice, aliceSecondSocket, bob], 'presence-room', undefined),
    ).toEqual([
      { userId: 'alice', userInfo: { name: 'Alice' } },
      { userId: 'bob', userInfo: { name: 'Bob' } },
    ])
  })

  it('excludes the socket that is leaving', () => {
    expect(collectPresenceMembers([alice, aliceSecondSocket, bob], 'presence-room', '1.1')).toEqual(
      [
        { userId: 'alice', userInfo: { name: 'Alice' } },
        { userId: 'bob', userInfo: { name: 'Bob' } },
      ],
    )
    expect(collectPresenceMembers([alice, bob], 'presence-room', '1.1')).toEqual([
      { userId: 'bob', userInfo: { name: 'Bob' } },
    ])
  })

  it('ignores other channels and public subscriptions', () => {
    expect(collectPresenceMembers([publicOnly, bob], 'presence-room', undefined)).toEqual([
      { userId: 'bob', userInfo: { name: 'Bob' } },
    ])
    expect(collectPresenceMembers([alice], 'presence-other', undefined)).toEqual([])
  })
})
