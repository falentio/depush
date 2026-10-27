import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import { OfflineScreen } from '@/components/states'

describe('OfflineScreen', () => {
  it('offers Reload for a malformed response', () => {
    const html = renderToStaticMarkup(
      OfflineScreen({ error: ApiError.malformed('bad'), onRetry: () => undefined }),
    )

    expect(html).toContain('Reload')
    expect(html).not.toContain('Try again')
  })

  it('offers Try again for a network error', () => {
    const html = renderToStaticMarkup(
      OfflineScreen({ error: ApiError.network(), onRetry: () => undefined }),
    )

    expect(html).toContain('Try again')
    expect(html).not.toContain('Reload')
  })
})
