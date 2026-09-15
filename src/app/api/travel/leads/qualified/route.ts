// ============================================================
// POST /api/travel/leads/qualified — the WhatsApp bot's webhook.
//
// Auth: a WACRM API key (`Authorization: Bearer wacrm_live_…`)
// carrying the `travel_leads:write` scope. The key is hashed at
// rest, resolves the tenant, and is rate-limited per key — the
// same machinery as the public /api/v1 surface. No service-role
// credential ever leaves the server.
//
// Idempotent on `bot_session_id`: a redelivered webhook returns
// the existing lead with `created: false` (HTTP 200 instead of 201).
//
// Response envelope matches /api/v1: `{ data }` / `{ error: { code, message } }`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, badRequest, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseQualifiedLeadPayload } from '@/lib/travel/qualified-payload';
import { ingestQualifiedLead } from '@/lib/travel/leads';
import { createRfqForLead } from '@/lib/travel/rfq';
import { getTravelSettings } from '@/lib/travel/settings';
import { TravelError } from '@/lib/travel/errors';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'travel_leads:write');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest('Body must be valid JSON');
    }
    const parsed = parseQualifiedLeadPayload(body);
    if (!parsed.ok) throw badRequest(parsed.error);

    const { lead, created, contactCreated } = await ingestQualifiedLead(ctx.supabase, ctx.accountId, parsed.value, { actorType: 'bot' });

    // Step 9: supplier matching + RFQ. Only for a freshly created lead —
    // a retried webhook must not fan out a second RFQ. Failures here are
    // recorded on the lead's timeline by the RFQ engine; the lead itself
    // is already safe, so we still return 201.
    let rfq: { id: string; version: number; recipients: number; matched: number } | null = null;
    if (created) {
      try {
        const settings = await getTravelSettings(ctx.supabase, ctx.accountId);
        const result = await createRfqForLead(ctx.supabase, ctx.accountId, lead.id, {
          actorUserId: null,
          send: settings.auto_send_rfq,
          request,
        });
        rfq = { id: result.rfq.id, version: result.rfq.version, recipients: result.recipients.length, matched: result.matchedCount };
      } catch (err) {
        console.error('[travel/qualified] RFQ creation failed (lead preserved):', err instanceof Error ? err.message : err);
      }
    }

    return ok(
      {
        lead_id: lead.id,
        deal_id: lead.deal_id,
        contact_id: lead.contact_id,
        conversation_id: lead.conversation_id,
        status: lead.status,
        created,
        contact_created: contactCreated,
        rfq,
      },
      created ? 201 : 200
    );
  } catch (err) {
    if (err instanceof TravelError) {
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    }
    return toApiErrorResponse(err);
  }
}
