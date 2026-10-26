import * as v from 'valibot'
import { validationError } from './errors'
import { issueDetails } from './validation'

export type Cursor = {
  createdAt: string
  id: string
}

const cursorSchema = v.object({
  createdAt: v.pipe(v.string(), v.minLength(1)),
  id: v.pipe(v.string(), v.minLength(1)),
})

export function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

export function decodeCursor(value: string): Cursor {
  const bytes = decodeBase64Url(value)
  if (bytes === null) throw validationError('Invalid cursor', issueDetails([]))

  const result = v.safeParse(cursorSchema, parseJson(bytes))
  if (!result.success) throw validationError('Invalid cursor', issueDetails(result.issues))
  return result.output
}
