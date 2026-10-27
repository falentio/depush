export const MAX_BODY_BYTES = 256 * 1024

export type CappedBody = { ok: true; body: Uint8Array } | { ok: false }

export function declaredBodyTooLarge(
  contentLength: string | null,
  maxBytes: number = MAX_BODY_BYTES,
): boolean {
  if (contentLength === null) return false
  const length = Number.parseInt(contentLength, 10)
  return Number.isFinite(length) && length > maxBytes
}

export async function readBodyCapped(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<CappedBody> {
  if (declaredBodyTooLarge(request.headers.get('content-length'), maxBytes)) {
    return { ok: false }
  }

  return readStreamCapped(request.body, maxBytes)
}

export async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<CappedBody> {
  if (stream === null) return { ok: true, body: new Uint8Array(0) }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return { ok: false }
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return { ok: true, body }
}
