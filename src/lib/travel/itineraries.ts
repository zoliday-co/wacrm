// ============================================================
// Itineraries — versioned per lead, manual for now. The data
// model is generator-agnostic: an AI generator later just writes
// the same rows with generated_by='ai'.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Itinerary, ItineraryDay } from '@/types/travel';
import { LEAD_EVENT_TYPES } from './constants';
import { recordLeadEvent } from './events';
import { badRequest, notFound } from './errors';

export interface ItineraryDayInput {
  day_number: number;
  date?: string | null;
  title: string;
  description?: string | null;
  hotel?: string | null;
  meals?: string | null;
  transport?: string | null;
  activities?: string[];
}

export interface ItineraryInput {
  title: string;
  summary?: string | null;
  hero_image_url?: string | null;
  traveller_quote_id?: string | null;
  days: ItineraryDayInput[];
  inclusions?: string | null;
  exclusions?: string | null;
  notes?: string | null;
  /** When editing: replace days of this DRAFT itinerary instead of creating a version. */
  itinerary_id?: string | null;
}

export function parseItineraryInput(raw: unknown): ItineraryInput {
  if (typeof raw !== 'object' || raw === null) throw badRequest('Invalid itinerary');
  const s = raw as Record<string, unknown>;
  const text = (v: unknown, max = 4000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const title = text(s.title, 200);
  if (!title) throw badRequest('Itinerary title is required');
  const days = Array.isArray(s.days)
    ? s.days
        .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
        .map((d, i) => ({
          day_number: typeof d.day_number === 'number' && d.day_number > 0 ? Math.round(d.day_number) : i + 1,
          date: typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null,
          title: text(d.title, 200) ?? `Day ${i + 1}`,
          description: text(d.description),
          hotel: text(d.hotel, 300),
          meals: text(d.meals, 200),
          transport: text(d.transport, 300),
          activities: Array.isArray(d.activities) ? d.activities.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim().slice(0, 200)).slice(0, 30) : [],
        }))
        .slice(0, 60)
    : [];
  if (days.length === 0) throw badRequest('Add at least one day');
  const seen = new Set<number>();
  for (const d of days) {
    if (seen.has(d.day_number)) throw badRequest(`Day ${d.day_number} appears twice`);
    seen.add(d.day_number);
  }
  return {
    title,
    summary: text(s.summary),
    hero_image_url: text(s.hero_image_url, 1000),
    traveller_quote_id: typeof s.traveller_quote_id === 'string' && s.traveller_quote_id ? s.traveller_quote_id : null,
    days,
    itinerary_id: typeof s.itinerary_id === 'string' && s.itinerary_id ? s.itinerary_id : null,
    inclusions: text(s.inclusions),
    exclusions: text(s.exclusions),
    notes: text(s.notes),
  };
}

export async function saveItinerary(
  db: SupabaseClient,
  accountId: string,
  leadId: string,
  input: ItineraryInput,
  actorUserId: string | null
): Promise<Itinerary> {
  let itinerary: Itinerary;
  let isNew = true;

  if (input.itinerary_id) {
    const { data: existing } = await db.from('itineraries').select('*').eq('id', input.itinerary_id).eq('account_id', accountId).eq('travel_lead_id', leadId).maybeSingle();
    if (!existing) throw notFound('Itinerary');
    if ((existing as Itinerary).status !== 'DRAFT') throw badRequest('Only draft itineraries can be edited — create a new version instead');
    const { data, error } = await db
      .from('itineraries')
      .update({ title: input.title, summary: input.summary ?? null, hero_image_url: input.hero_image_url ?? null, traveller_quote_id: input.traveller_quote_id ?? null, extras: itineraryExtras(input) })
      .eq('id', input.itinerary_id)
      .select('*')
      .single();
    if (error || !data) throw new Error(`Failed to update itinerary: ${error?.message}`);
    itinerary = data as Itinerary;
    isNew = false;
    await db.from('itinerary_days').delete().eq('itinerary_id', itinerary.id);
  } else {
    const { data: prev } = await db.from('itineraries').select('version').eq('travel_lead_id', leadId).eq('account_id', accountId).order('version', { ascending: false }).limit(1);
    const version = ((prev?.[0]?.version as number | undefined) ?? 0) + 1;
    const { data, error } = await db
      .from('itineraries')
      .insert({
        account_id: accountId,
        travel_lead_id: leadId,
        traveller_quote_id: input.traveller_quote_id ?? null,
        version,
        title: input.title,
        summary: input.summary ?? null,
        hero_image_url: input.hero_image_url ?? null,
        status: 'DRAFT',
        generated_by: 'manual',
        extras: itineraryExtras(input),
        created_by: actorUserId,
      })
      .select('*')
      .single();
    if (error || !data) throw new Error(`Failed to create itinerary: ${error?.message}`);
    itinerary = data as Itinerary;
  }

  const { error: dayErr } = await db.from('itinerary_days').insert(
    input.days
      .sort((a, b) => a.day_number - b.day_number)
      .map((d, i) => ({
        account_id: accountId,
        itinerary_id: itinerary.id,
        day_number: d.day_number,
        date: d.date ?? null,
        title: d.title,
        description: d.description ?? null,
        hotel: d.hotel ?? null,
        meals: d.meals ?? null,
        transport: d.transport ?? null,
        activities: d.activities ?? [],
        sort_order: i,
      }))
  );
  if (dayErr) throw new Error(`Failed to save itinerary days: ${dayErr.message}`);

  if (isNew) {
    await recordLeadEvent(db, {
      accountId,
      leadId,
      type: LEAD_EVENT_TYPES.ITINERARY_CREATED,
      actorType: 'agent',
      actorUserId,
      title: `Itinerary V${itinerary.version} created — ${itinerary.title} (${input.days.length} days)`,
      details: { itinerary_id: itinerary.id, version: itinerary.version },
    });
  }
  return getItinerary(db, accountId, itinerary.id);
}

export async function getItinerary(db: SupabaseClient, accountId: string, id: string): Promise<Itinerary> {
  const { data } = await db.from('itineraries').select('*, days:itinerary_days(*)').eq('id', id).eq('account_id', accountId).maybeSingle();
  if (!data) throw notFound('Itinerary');
  const it = data as Itinerary;
  it.days = (it.days ?? []).sort((a: ItineraryDay, b: ItineraryDay) => a.day_number - b.day_number);
  return it;
}

export async function listItineraries(db: SupabaseClient, accountId: string, leadId?: string | null): Promise<Itinerary[]> {
  let q = db
    .from('itineraries')
    .select('*, days:itinerary_days(*), travel_lead:travel_leads(id, traveller_name, destination_primary, status)')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (leadId) q = q.eq('travel_lead_id', leadId);
  const { data } = await q;
  return ((data ?? []) as Itinerary[]).map((it) => ({ ...it, days: (it.days ?? []).sort((a, b) => a.day_number - b.day_number) }));
}

export async function setItineraryStatus(db: SupabaseClient, accountId: string, id: string, status: 'DRAFT' | 'FINAL' | 'ARCHIVED', actorUserId: string | null = null): Promise<Itinerary> {
  const current = await getItinerary(db, accountId, id);
  const { error } = await db.from('itineraries').update({ status }).eq('id', id).eq('account_id', accountId);
  if (error) throw new Error(`Failed to update itinerary: ${error.message}`);
  if (status === 'FINAL' && current.status !== 'FINAL') {
    await recordLeadEvent(db, {
      accountId,
      leadId: current.travel_lead_id,
      type: LEAD_EVENT_TYPES.ITINERARY_FINALIZED,
      actorType: 'agent',
      actorUserId,
      title: `Itinerary V${current.version} finalized — ${current.title}`,
      details: { itinerary_id: id, version: current.version },
    });
  }
  return getItinerary(db, accountId, id);
}

function itineraryExtras(input: ItineraryInput): Record<string, string | null> {
  return {
    inclusions: input.inclusions ?? null,
    exclusions: input.exclusions ?? null,
    notes: input.notes ?? null,
  };
}

/** Seed a day-per-night skeleton from the lead so agents start from structure, not a blank page. */
export function skeletonDays(lead: { nights: number | null; days: number | null; destination_primary: string | null; destinations: string[]; travel_start_date: string | null; pickup_location: string | null; drop_location: string | null }): ItineraryDayInput[] {
  const count = lead.days ?? (lead.nights != null ? lead.nights + 1 : 1);
  const subs = lead.destinations ?? [];
  const out: ItineraryDayInput[] = [];
  for (let i = 0; i < count; i++) {
    const date = lead.travel_start_date ? new Date(new Date(`${lead.travel_start_date}T00:00:00Z`).getTime() + i * 86_400_000).toISOString().slice(0, 10) : null;
    const place = subs.length ? subs[Math.min(subs.length - 1, Math.floor((i * subs.length) / Math.max(1, count - 1 || 1)))] : lead.destination_primary;
    let title: string;
    if (i === 0) title = `Arrival${lead.pickup_location ? ` at ${lead.pickup_location}` : ''}${place ? ` → ${place}` : ''}`;
    else if (i === count - 1) title = `Departure${lead.drop_location ? ` from ${lead.drop_location}` : ''}`;
    else title = place ? `${place} sightseeing` : `Day ${i + 1}`;
    out.push({ day_number: i + 1, date, title, activities: [] });
  }
  return out;
}
