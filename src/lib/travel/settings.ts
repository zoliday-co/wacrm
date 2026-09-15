// ============================================================
// travel_settings access — one row per account, created lazily
// with defaults the first time the travel layer touches an
// account. Pure defaults are exported for tests + the UI.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TravelSettings } from '@/types/travel';

export const TRAVEL_SETTINGS_DEFAULTS: Omit<
  TravelSettings,
  'id' | 'account_id' | 'created_at' | 'updated_at'
> = {
  pipeline_id: null,
  currency: 'INR',
  max_suppliers_per_rfq: 5,
  min_quotes_before_notification: 3,
  rfq_deadline_hours: 24,
  supplier_quote_token_ttl_hours: 72,
  supplier_reminder_hours: 4,
  supplier_max_reminders: 2,
  auto_send_rfq: true,
  auto_notify_traveller: true,
  supplier_rfq_template_name: null,
  supplier_rfq_template_language: null,
  traveller_quotes_ready_template_name: null,
  traveller_quotes_ready_template_language: null,
  callback_token_ttl_hours: 168,
  gst_rate: '5.00',
  gst_taxable_base: 'selling_price',
  default_markup_type: 'percent',
  default_markup_value: '15.00',
  margin_warning_pct: '8.00',
  margin_approval_pct: null,
  traveller_quote_validity_days: 7,
};

/** Fields an admin may edit through PUT /api/travel/settings. */
export const EDITABLE_SETTINGS_KEYS = [
  'currency',
  'max_suppliers_per_rfq',
  'min_quotes_before_notification',
  'rfq_deadline_hours',
  'supplier_quote_token_ttl_hours',
  'supplier_reminder_hours',
  'supplier_max_reminders',
  'auto_send_rfq',
  'auto_notify_traveller',
  'supplier_rfq_template_name',
  'supplier_rfq_template_language',
  'traveller_quotes_ready_template_name',
  'traveller_quotes_ready_template_language',
  'callback_token_ttl_hours',
  'gst_rate',
  'gst_taxable_base',
  'default_markup_type',
  'default_markup_value',
  'margin_warning_pct',
  'margin_approval_pct',
  'traveller_quote_validity_days',
] as const;

export async function getTravelSettings(
  db: SupabaseClient,
  accountId: string
): Promise<TravelSettings> {
  const { data } = await db
    .from('travel_settings')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();
  if (data) return data as TravelSettings;

  const { data: created, error } = await db
    .from('travel_settings')
    .insert({ account_id: accountId })
    .select('*')
    .single();
  if (error || !created) {
    // Lost a race (unique account_id) — re-read; otherwise fall back to
    // in-memory defaults so a settings hiccup never blocks a lead.
    const { data: again } = await db
      .from('travel_settings')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();
    if (again) return again as TravelSettings;
    return {
      id: 'defaults',
      account_id: accountId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...TRAVEL_SETTINGS_DEFAULTS,
    };
  }
  return created as TravelSettings;
}

/** Validate + coerce a settings patch. Unknown keys are dropped. */
export function sanitizeSettingsPatch(raw: unknown): Partial<TravelSettings> {
  if (typeof raw !== 'object' || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const ints: Record<string, [number, number]> = {
    max_suppliers_per_rfq: [1, 50],
    min_quotes_before_notification: [1, 50],
    rfq_deadline_hours: [1, 720],
    supplier_quote_token_ttl_hours: [1, 2160],
    supplier_reminder_hours: [1, 720],
    supplier_max_reminders: [0, 10],
    callback_token_ttl_hours: [1, 2160],
    traveller_quote_validity_days: [1, 365],
  };
  for (const key of EDITABLE_SETTINGS_KEYS) {
    if (!(key in src)) continue;
    const v = src[key];
    if (key in ints) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) {
        const [lo, hi] = ints[key];
        out[key] = Math.min(hi, Math.max(lo, Math.round(n)));
      }
      continue;
    }
    switch (key) {
      case 'auto_send_rfq':
      case 'auto_notify_traveller':
        if (typeof v === 'boolean') out[key] = v;
        break;
      case 'gst_taxable_base':
        if (v === 'selling_price' || v === 'markup') out[key] = v;
        break;
      case 'default_markup_type':
        if (v === 'percent' || v === 'fixed') out[key] = v;
        break;
      case 'gst_rate':
      case 'default_markup_value':
      case 'margin_warning_pct':
      case 'margin_approval_pct': {
        if (v === null || v === '') {
          if (key === 'margin_approval_pct') out[key] = null;
          break;
        }
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(n) && n >= 0) out[key] = n.toFixed(2);
        break;
      }
      case 'currency':
        if (typeof v === 'string' && /^[A-Z]{3}$/.test(v)) out[key] = v;
        break;
      default:
        // template names / languages
        if (v === null || v === '') out[key] = null;
        else if (typeof v === 'string' && v.length <= 512) out[key] = v.trim();
    }
  }
  return out as Partial<TravelSettings>;
}
