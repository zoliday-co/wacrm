// ============================================================
// Requirement versions — immutable snapshots of what the
// traveller asked for. V1 comes from the bot; every agent edit
// appends a new version and re-syncs the denormalised copy on
// travel_leads. Nothing here ever UPDATEs a version row.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RequirementInput, TravelLead, TravelRequirementVersion } from '@/types/travel';
import { LEAD_EVENT_TYPES } from './constants';
import { recordLeadEvent } from './events';
import { badRequest, notFound } from './errors';

/** Requirement columns shared by travel_leads + travel_requirement_versions. */
export const REQUIREMENT_FIELDS = [
  'destination_primary',
  'destinations',
  'departure_city',
  'travel_start_date',
  'travel_end_date',
  'travel_month',
  'dates_flexible',
  'flexibility_days',
  'nights',
  'days',
  'adults',
  'children',
  'infants',
  'child_ages',
  'room_count',
  'room_configuration',
  'hotel_category',
  'meal_plan',
  'hotel_preferences',
  'vehicle_type',
  'pickup_location',
  'drop_location',
  'budget_amount',
  'budget_type',
  'activities',
  'special_requests',
] as const;

export type RequirementField = (typeof REQUIREMENT_FIELDS)[number];

/** Pick the requirement columns off any object (lead, version, input). */
export function pickRequirement(src: Record<string, unknown>): Record<RequirementField, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of REQUIREMENT_FIELDS) if (f in src) out[f] = src[f];
  return out as Record<RequirementField, unknown>;
}

/** Coerce a client-supplied requirement patch into DB-safe values. */
export function sanitizeRequirementInput(raw: unknown): RequirementInput {
  if (typeof raw !== 'object' || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const strField = (k: string) => {
    if (!(k in src)) return;
    const v = src[k];
    out[k] = typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : null;
  };
  const intField = (k: string, nullable = true) => {
    if (!(k in src)) return;
    const v = src[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (Number.isFinite(n)) out[k] = Math.max(0, Math.round(n));
    else if (nullable) out[k] = null;
  };
  const listField = (k: string) => {
    if (!(k in src)) return;
    const v = src[k];
    out[k] = Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim()) : [];
  };
  strField('destination_primary');
  listField('destinations');
  strField('departure_city');
  for (const k of ['travel_start_date', 'travel_end_date']) {
    if (!(k in src)) continue;
    const v = src[k];
    out[k] = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  }
  strField('travel_month');
  if ('dates_flexible' in src) out.dates_flexible = Boolean(src.dates_flexible);
  intField('flexibility_days');
  intField('nights');
  intField('days');
  intField('adults');
  intField('children');
  intField('infants');
  if ('child_ages' in src) {
    const v = src.child_ages;
    out.child_ages = Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n) && n >= 0).map((n) => Math.round(n)) : [];
  }
  intField('room_count');
  strField('room_configuration');
  strField('hotel_category');
  strField('meal_plan');
  listField('hotel_preferences');
  strField('vehicle_type');
  strField('pickup_location');
  strField('drop_location');
  if ('budget_amount' in src) {
    const v = src.budget_amount;
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[,₹\s]/g, '')) : NaN;
    out.budget_amount = Number.isFinite(n) && n >= 0 ? n.toFixed(2) : null;
  }
  if ('budget_type' in src) {
    out.budget_type = src.budget_type === 'per_person' ? 'per_person' : src.budget_type === 'total' ? 'total' : null;
  }
  listField('activities');
  strField('special_requests');
  if (out.adults === undefined && 'adults' in src) out.adults = 0;
  return out as RequirementInput;
}

/** Insert version N for a lead. Does not touch the lead row. */
export async function insertRequirementVersion(
  db: SupabaseClient,
  accountId: string,
  leadId: string,
  version: number,
  fields: RequirementInput,
  meta: { change_reason?: string | null; created_by?: string | null }
): Promise<TravelRequirementVersion> {
  const { data, error } = await db
    .from('travel_requirement_versions')
    .insert({
      account_id: accountId,
      travel_lead_id: leadId,
      version,
      ...pickRequirement(fields as Record<string, unknown>),
      change_reason: meta.change_reason ?? null,
      created_by: meta.created_by ?? null,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`Failed to store requirement version: ${error?.message ?? 'unknown'}`);
  }
  return data as TravelRequirementVersion;
}

/**
 * Append a new requirement version from an agent edit, sync the
 * lead's denormalised copy and log the diff. Returns the version.
 */
export async function reviseRequirement(
  db: SupabaseClient,
  accountId: string,
  leadId: string,
  patch: RequirementInput,
  opts: { reason?: string | null; actorUserId: string | null }
): Promise<{ version: TravelRequirementVersion; lead: TravelLead }> {
  const { data: leadRow } = await db
    .from('travel_leads')
    .select('*')
    .eq('id', leadId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!leadRow) throw notFound('Lead');
  const lead = leadRow as TravelLead;

  const current = pickRequirement(lead as unknown as Record<string, unknown>);
  const next = { ...current, ...pickRequirement(patch as Record<string, unknown>) } as RequirementInput;

  const changed = REQUIREMENT_FIELDS.filter(
    (f) => JSON.stringify(current[f] ?? null) !== JSON.stringify((next as Record<string, unknown>)[f] ?? null)
  );
  if (changed.length === 0) throw badRequest('No requirement fields changed');

  const nextVersion = (lead.current_requirement_version ?? 1) + 1;
  const version = await insertRequirementVersion(db, accountId, leadId, nextVersion, next, {
    change_reason: opts.reason ?? null,
    created_by: opts.actorUserId,
  });

  const { data: updated, error } = await db
    .from('travel_leads')
    .update({
      ...pickRequirement(next as Record<string, unknown>),
      current_requirement_version: nextVersion,
      current_requirement_version_id: version.id,
    })
    .eq('id', leadId)
    .eq('account_id', accountId)
    .select('*')
    .single();
  if (error || !updated) throw new Error(`Failed to update lead requirement: ${error?.message}`);

  await recordLeadEvent(db, {
    accountId,
    leadId,
    type: LEAD_EVENT_TYPES.REQUIREMENT_MODIFIED,
    actorType: 'agent',
    actorUserId: opts.actorUserId,
    title: `Requirement updated to V${nextVersion}${opts.reason ? ` — ${opts.reason}` : ''}`,
    details: { version: nextVersion, changed_fields: changed, reason: opts.reason ?? null },
    oldValue: Object.fromEntries(changed.map((f) => [f, current[f] ?? null])),
    newValue: Object.fromEntries(changed.map((f) => [f, (next as Record<string, unknown>)[f] ?? null])),
  });

  return { version, lead: updated as TravelLead };
}

export async function listRequirementVersions(
  db: SupabaseClient,
  accountId: string,
  leadId: string
): Promise<TravelRequirementVersion[]> {
  const { data } = await db
    .from('travel_requirement_versions')
    .select('*')
    .eq('account_id', accountId)
    .eq('travel_lead_id', leadId)
    .order('version', { ascending: false });
  return (data ?? []) as TravelRequirementVersion[];
}
