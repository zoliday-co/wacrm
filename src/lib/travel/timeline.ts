// ============================================================
// Unified lead timeline — merges (at read time, never copied):
//   travel_lead_events   (structured audit log)
//   lead_interactions    (calls / notes)
//   messages             (the WhatsApp thread, summarised)
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Message } from '@/types';
import type { LeadInteraction, TimelineEntry, TravelLeadEvent } from '@/types/travel';

export async function getLeadTimeline(
  db: SupabaseClient,
  accountId: string,
  lead: { id: string; conversation_id: string | null },
  opts: { includeMessages?: boolean; limit?: number } = {}
): Promise<TimelineEntry[]> {
  const limit = Math.min(500, opts.limit ?? 200);
  const [events, interactions, messages] = await Promise.all([
    db.from('travel_lead_events').select('*').eq('account_id', accountId).eq('travel_lead_id', lead.id).order('created_at', { ascending: false }).limit(limit),
    db.from('lead_interactions').select('*, agent:profiles!lead_interactions_agent_id_fkey(full_name)').eq('account_id', accountId).eq('travel_lead_id', lead.id).order('occurred_at', { ascending: false }).limit(limit),
    opts.includeMessages !== false && lead.conversation_id
      ? db.from('messages').select('id, sender_type, content_type, content_text, created_at, ai_generated').eq('conversation_id', lead.conversation_id).order('created_at', { ascending: false }).limit(limit)
      : Promise.resolve({ data: [] as Message[] }),
  ]);

  const actorNames = await resolveActorNames(db, accountId, [
    ...((events.data ?? []) as TravelLeadEvent[]).map((e) => e.actor_user_id),
  ]);

  const entries: TimelineEntry[] = [];
  for (const e of (events.data ?? []) as TravelLeadEvent[]) {
    // Interactions already appear as their own rows — skip the mirror events.
    if (e.event_type === 'customer_called' || e.event_type === 'note_added') continue;
    entries.push({
      id: `e:${e.id}`,
      kind: 'event',
      at: e.created_at,
      title: e.title,
      actor: e.actor_user_id ? actorNames.get(e.actor_user_id) ?? null : actorLabel(e.actor_type),
      event_type: e.event_type,
      details: e.details,
    });
  }
  for (const i of (interactions.data ?? []) as (LeadInteraction & { agent?: { full_name: string } | null })[]) {
    entries.push({
      id: `i:${i.id}`,
      kind: 'interaction',
      at: i.occurred_at,
      title: `${i.interaction_type === 'CALL' ? '📞 ' : i.interaction_type === 'MEETING' ? '🤝 ' : '📝 '}${i.summary}`,
      body: [i.details, i.outcome ? `Outcome: ${i.outcome}` : null].filter(Boolean).join('\n'),
      actor: i.agent?.full_name ?? null,
      event_type: i.interaction_type.toLowerCase(),
    });
  }
  for (const m of (messages.data ?? []) as (Pick<Message, 'id' | 'sender_type' | 'content_type' | 'content_text' | 'created_at'> & { ai_generated?: boolean })[]) {
    const who = m.sender_type === 'customer' ? 'Traveller' : m.ai_generated || m.sender_type === 'bot' ? 'Bot' : 'Agent';
    const text = m.content_text?.trim() || `[${m.content_type}]`;
    entries.push({
      id: `m:${m.id}`,
      kind: 'message',
      at: m.created_at,
      title: `${who}: ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`,
      actor: who,
      event_type: `message_${m.sender_type}`,
    });
  }
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return entries.slice(0, limit);
}

async function resolveActorNames(db: SupabaseClient, accountId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const map = new Map<string, string>();
  if (!unique.length) return map;
  const { data } = await db.from('profiles').select('user_id, full_name').eq('account_id', accountId).in('user_id', unique);
  for (const p of data ?? []) map.set(p.user_id as string, (p.full_name as string) || 'Agent');
  return map;
}

function actorLabel(t: TravelLeadEvent['actor_type']): string {
  switch (t) {
    case 'bot':
      return 'Bot';
    case 'supplier':
      return 'Supplier';
    case 'traveller':
      return 'Traveller';
    case 'agent':
      return 'Agent';
    default:
      return 'System';
  }
}
