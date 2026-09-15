// ============================================================
// Lead event log + outbound fan-out.
//
// `recordLeadEvent` is the ONE way a travel event gets written:
// it appends to travel_lead_events (the audit trail / timeline),
// bumps the lead's `last_activity_at`, and — when a lifecycle
// trigger is named — fans out to the existing WACRM automation
// engine and outbound webhooks. Nothing else in the travel layer
// calls those engines directly, so adding a hook is one place.
//
// Fan-out is fire-and-forget and swallows errors: a broken
// automation must never fail the lead write it reacts to.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutomationTriggerType } from '@/types';
import type { LeadEventActor, TravelLeadEvent } from '@/types/travel';
import { runAutomationsForTrigger, type AutomationContext } from '@/lib/automations/engine';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import type { WebhookEvent } from '@/lib/webhooks/events';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export interface RecordEventInput {
  accountId: string;
  leadId: string;
  type: string;
  title: string;
  actorType?: LeadEventActor;
  actorUserId?: string | null;
  details?: Record<string, unknown>;
  oldValue?: unknown;
  newValue?: unknown;
  /** Optional lifecycle fan-out. */
  trigger?: {
    automation?: AutomationTriggerType;
    webhook?: WebhookEvent;
    contactId?: string | null;
    conversationId?: string | null;
    payload?: Record<string, unknown>;
  };
}

export async function recordLeadEvent(
  db: SupabaseClient,
  input: RecordEventInput
): Promise<TravelLeadEvent | null> {
  const row = {
    account_id: input.accountId,
    travel_lead_id: input.leadId,
    event_type: input.type,
    actor_type: input.actorType ?? 'system',
    actor_user_id: input.actorUserId ?? null,
    title: input.title,
    details: input.details ?? {},
    old_value: input.oldValue ?? null,
    new_value: input.newValue ?? null,
  };

  const { data, error } = await db.from('travel_lead_events').insert(row).select('*').single();
  if (error) {
    console.error('[travel/events] insert failed:', error.message, { type: input.type, leadId: input.leadId });
  }

  await db
    .from('travel_leads')
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', input.leadId)
    .eq('account_id', input.accountId);

  if (input.trigger) {
    fanOut(input).catch((err) =>
      console.error('[travel/events] fan-out failed:', err instanceof Error ? err.message : err)
    );
  }

  return (data as TravelLeadEvent | null) ?? null;
}

async function fanOut(input: RecordEventInput): Promise<void> {
  const t = input.trigger!;
  const payload = {
    travel_lead_id: input.leadId,
    event_type: input.type,
    title: input.title,
    ...(input.details ?? {}),
    ...(t.payload ?? {}),
  };
  const jobs: Promise<unknown>[] = [];
  if (t.automation) {
    const context: AutomationContext = {
      conversation_id: t.conversationId ?? undefined,
      vars: payload,
    };
    jobs.push(
      runAutomationsForTrigger({
        accountId: input.accountId,
        triggerType: t.automation,
        contactId: t.contactId ?? null,
        context,
      })
    );
  }
  if (t.webhook) {
    jobs.push(dispatchWebhookEvent(supabaseAdmin(), input.accountId, t.webhook, payload));
  }
  await Promise.allSettled(jobs);
}
