import { md5 } from '@noble/hashes/legacy.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()

export function canonicalQuery(searchParams: URLSearchParams): string {
  const pairs: [string, string][] = []
  for (const [key, value] of searchParams) {
    const lower = key.toLowerCase()
    if (lower === 'auth_signature') continue
    pairs.push([lower, value])
  }

  return pairs
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

export function signingString(method: string, path: string, searchParams: URLSearchParams): string {
  return [method.toUpperCase(), path, canonicalQuery(searchParams)].join('\n')
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return bytesToHex(new Uint8Array(signature))
}

export function md5Hex(body: Uint8Array): string {
  return bytesToHex(md5(body))
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false

  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}
