/**
 * WhatsApp send doctor — answers "why won't Meta take our messages?"
 *
 * Meta answers a blocked account and a malformed payload with the same
 * useless "An unknown error has occurred." (code 1). This script separates
 * the two without sending anything to a customer:
 *
 *   1. Reads whatsapp_config, decrypts the token, and asks Meta for the
 *      health_status of the number, the WABA, the business and the app.
 *      Exactly one of those four is usually the blocker, and it says so.
 *   2. Optionally posts a known-good text payload (--probe) to prove the
 *      format is fine. The recipient is an unallocated number, so nothing
 *      is delivered — only the SHAPE of the error matters:
 *        code 100 → our payload is wrong
 *        code 131030 → payload fine, recipient not allowed
 *        code 1 + HTTP 500 → payload fine, the account is blocked
 *
 * Usage:  node scripts/whatsapp-doctor.mjs [--probe]
 */
import fs from 'fs'
import crypto from 'crypto'

const env = {}
for (const line of fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

function decrypt(text) {
  const parts = text.split(':')
  const key = Buffer.from(env.ENCRYPTION_KEY, 'hex')
  if (parts.length === 3) {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'))
    d.setAuthTag(Buffer.from(parts[2], 'hex'))
    return d.update(parts[1], 'hex', 'utf8') + d.final('utf8')
  }
  const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(parts[0], 'hex'))
  return d.update(parts[1], 'hex', 'utf8') + d.final('utf8')
}

const sb = async (path) => {
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  })
  return r.json()
}

const configs = await sb('whatsapp_config?select=*')
if (!configs.length) {
  console.error('No whatsapp_config rows — nothing to check.')
  process.exit(1)
}

for (const config of configs) {
  const token = decrypt(config.access_token)
  const graph = async (path) => {
    const r = await fetch(`https://graph.facebook.com/v21.0/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return [r.status, await r.json()]
  }

  console.log(`\n=== account ${config.account_id}`)
  console.log(`    waba ${config.waba_id} · number ${config.phone_number_id}`)

  const [, phone] = await graph(
    `${config.phone_number_id}?fields=display_phone_number,verified_name,status,account_mode,quality_rating,messaging_limit_tier,code_verification_status`
  )
  if (phone.error) {
    console.log(`    number lookup FAILED: ${phone.error.message}`)
    continue
  }
  console.log(
    `    ${phone.display_phone_number} "${phone.verified_name}" · ${phone.status} · ` +
      `${phone.account_mode} · quality ${phone.quality_rating} · ${phone.messaging_limit_tier}`
  )

  const [, health] = await graph(`${config.phone_number_id}?fields=health_status`)
  const hs = health.health_status
  if (!hs) {
    console.log('    no health_status returned')
    continue
  }
  console.log(`\n    CAN SEND: ${hs.can_send_message}`)
  for (const e of hs.entities ?? []) {
    console.log(`      ${e.entity_type.padEnd(13)} ${e.can_send_message}`)
    // SIP/calling errors are noise for a messaging-only integration.
    for (const err of (e.errors ?? []).filter((x) => ![138024, 138025].includes(x.error_code))) {
      console.log(`        ✗ ${err.error_code}  ${err.error_description}`)
      console.log(`          → ${err.possible_solution}`)
    }
    for (const info of e.additional_info ?? []) console.log(`        · ${info}`)
  }

  if (!process.argv.includes('--probe')) continue

  // Nothing reaches a real person: this number is unallocated, and a
  // blocked account fails before delivery is even considered.
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '919999999999',
    type: 'text',
    text: { body: 'format check' },
  }
  const r = await fetch(
    `https://graph.facebook.com/v21.0/${config.phone_number_id}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }
  )
  const out = await r.json()
  const code = out.error?.code
  console.log(`\n    PROBE  HTTP ${r.status}  ${JSON.stringify(out.error ?? out.messages)}`)
  console.log(
    '    verdict: ' +
      (code === 100
        ? 'PAYLOAD IS MALFORMED — Meta named the bad param above.'
        : code === 1
          ? 'payload fine, account blocked — see CAN SEND above.'
          : code === 131030
            ? 'payload fine, recipient not on the allow list.'
            : r.ok
              ? 'payload fine, Meta accepted it.'
              : `payload fine, unexpected error code ${code}.`)
  )
}
