import { describe, expect, it } from 'vitest'
import { canonicalQuery, hmacHex, md5Hex, signingString } from '../src/signature'

const APP_KEY = '278d425bdf160c739803'
const APP_SECRET = '7ad3773142a6692b25b8'
const WORKED_BODY = '{"name":"foo","channels":["project-3"],"data":"{\\"some\\":\\"data\\"}"}'
const WORKED_QUERY =
  'auth_key=278d425bdf160c739803&auth_timestamp=1353088179&auth_version=1.0&body_md5=ec365a775a4cd0599faeb73354201b6f'
const WORKED_SIGNATURE = 'da454824c97ba181a32ccc17a72625ba02771f50b50e1e7430e47a1f3f457e6c'

describe('signing', () => {
  it('matches the API.md worked signature vector', async () => {
    const params = new URLSearchParams(WORKED_QUERY)
    const stringToSign = signingString('POST', '/apps/3/events', params)

    expect(stringToSign).toBe(`POST\n/apps/3/events\n${WORKED_QUERY}`)
    expect(await hmacHex(APP_SECRET, stringToSign)).toBe(WORKED_SIGNATURE)
  })

  it('matches the API.md worked body_md5 vector', () => {
    expect(md5Hex(new TextEncoder().encode(WORKED_BODY))).toBe('ec365a775a4cd0599faeb73354201b6f')
  })

  it('sorts lowercased keys, leaves values unescaped, and drops auth_signature', () => {
    const params = new URLSearchParams(
      `Name=Something else&auth_key=${APP_KEY}&auth_signature=ignored&Zed=last`,
    )

    expect(canonicalQuery(params)).toBe(`auth_key=${APP_KEY}&name=Something else&zed=last`)
  })
})
