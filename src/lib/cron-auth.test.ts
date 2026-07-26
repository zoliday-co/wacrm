import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { verifyCronSecret, isCronConfigured } from './cron-auth'

const SECRET = 'a-long-random-cron-secret'

function req(headers: Record<string, string>): Request {
  return new Request('https://example.test/api/automations/cron', { headers })
}

describe('cron auth', () => {
  const original = { ...process.env }

  beforeEach(() => {
    delete process.env.AUTOMATION_CRON_SECRET
    delete process.env.CRON_SECRET
  })

  afterEach(() => {
    process.env = { ...original }
  })

  it('reports unconfigured when neither env var is set', () => {
    expect(isCronConfigured()).toBe(false)
    expect(verifyCronSecret(req({ 'x-cron-secret': SECRET }))).toBe(false)
  })

  it('accepts the x-cron-secret header (external pingers)', () => {
    process.env.AUTOMATION_CRON_SECRET = SECRET
    expect(verifyCronSecret(req({ 'x-cron-secret': SECRET }))).toBe(true)
  })

  it('accepts Authorization: Bearer (Vercel Cron)', () => {
    process.env.AUTOMATION_CRON_SECRET = SECRET
    expect(verifyCronSecret(req({ authorization: `Bearer ${SECRET}` }))).toBe(
      true
    )
  })

  it('falls back to CRON_SECRET, the name Vercel already requires', () => {
    process.env.CRON_SECRET = SECRET
    expect(isCronConfigured()).toBe(true)
    expect(verifyCronSecret(req({ authorization: `Bearer ${SECRET}` }))).toBe(
      true
    )
  })

  it('treats the Bearer scheme case-insensitively', () => {
    process.env.AUTOMATION_CRON_SECRET = SECRET
    expect(verifyCronSecret(req({ authorization: `bearer ${SECRET}` }))).toBe(
      true
    )
  })

  it('rejects a wrong secret, including one of matching length', () => {
    process.env.AUTOMATION_CRON_SECRET = SECRET
    const sameLength = 'b'.repeat(SECRET.length)
    expect(verifyCronSecret(req({ 'x-cron-secret': sameLength }))).toBe(false)
    expect(verifyCronSecret(req({ 'x-cron-secret': 'short' }))).toBe(false)
  })

  it('rejects a request with no auth headers at all', () => {
    process.env.AUTOMATION_CRON_SECRET = SECRET
    expect(verifyCronSecret(req({}))).toBe(false)
  })

  it('does not fall through to x-cron-secret when Bearer is present but wrong', () => {
    process.env.AUTOMATION_CRON_SECRET = SECRET
    // A caller presenting a Bearer token is claiming that scheme; a
    // valid secondary header must not rescue a bad primary one.
    const r = req({ authorization: 'Bearer wrong', 'x-cron-secret': SECRET })
    expect(verifyCronSecret(r)).toBe(false)
  })
})
