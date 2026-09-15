// ============================================================
// Suppliers + destinations: validation, CRUD helpers, and the
// default Indian destination seed.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Destination, Supplier, SupplierDestination, SupplierStatus, SupplierType } from '@/types/travel';
import { SUPPLIER_TYPES } from '@/types/travel';
import { badRequest, notFound } from './errors';
import { slugify } from './matching';
import { DEFAULT_DESTINATIONS } from './constants';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

// ------------------------------------------------------------
// Destinations
// ------------------------------------------------------------


export async function seedDefaultDestinations(db: SupabaseClient, accountId: string): Promise<number> {
  let created = 0;
  for (const d of DEFAULT_DESTINATIONS) {
    const slug = slugify(d.name);
    const { data: existing } = await db.from('destinations').select('id').eq('account_id', accountId).eq('slug', slug).maybeSingle();
    let parent = existing;
    if (!parent) {
      const result = await db
        .from('destinations')
        .insert({ account_id: accountId, name: d.name, slug, aliases: d.aliases ?? [] })
        .select('id')
        .single();
      parent = result.data;
      if (parent) created += 1;
    }
    if (!parent) continue;
    if (d.children?.length) {
      for (const child of d.children) {
        const childSlug = slugify(child);
        const { data: found } = await db.from('destinations').select('id').eq('account_id', accountId).eq('slug', childSlug).maybeSingle();
        if (found) continue;
        const { error } = await db.from('destinations').insert({ account_id: accountId, name: child, slug: childSlug, parent_id: parent.id });
        if (!error) created += 1;
      }
    }
  }
  return created;
}

export async function listDestinations(db: SupabaseClient, accountId: string): Promise<Destination[]> {
  const { data } = await db.from('destinations').select('*').eq('account_id', accountId).order('name');
  return (data ?? []) as Destination[];
}

/** Nest children under parents for the UI. */
export function destinationTree(flat: Destination[]): Destination[] {
  const byId = new Map(flat.map((d) => [d.id, { ...d, children: [] as Destination[] }]));
  const roots: Destination[] = [];
  for (const d of byId.values()) {
    if (d.parent_id && byId.has(d.parent_id)) byId.get(d.parent_id)!.children!.push(d);
    else roots.push(d);
  }
  return roots;
}

export function parseDestinationInput(raw: unknown): { name: string; parent_id: string | null; aliases: string[]; active: boolean } {
  if (typeof raw !== 'object' || raw === null) throw badRequest('Invalid destination');
  const s = raw as Record<string, unknown>;
  const name = typeof s.name === 'string' ? s.name.trim().slice(0, 120) : '';
  if (!name) throw badRequest('Destination name is required');
  return {
    name,
    parent_id: typeof s.parent_id === 'string' && s.parent_id ? s.parent_id : null,
    aliases: Array.isArray(s.aliases) ? s.aliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim().toLowerCase()).slice(0, 20) : [],
    active: s.active === undefined ? true : Boolean(s.active),
  };
}

export async function createDestination(db: SupabaseClient, accountId: string, raw: unknown): Promise<Destination> {
  const input = parseDestinationInput(raw);
  if (input.parent_id) {
    const { data: parent } = await db.from('destinations').select('id').eq('id', input.parent_id).eq('account_id', accountId).maybeSingle();
    if (!parent) throw badRequest('Parent destination not found');
  }
  const { data, error } = await db
    .from('destinations')
    .insert({ account_id: accountId, name: input.name, slug: slugify(input.name), parent_id: input.parent_id, aliases: input.aliases, active: input.active })
    .select('*')
    .single();
  if (error || !data) {
    if (/duplicate key|23505/.test(error?.message ?? '')) throw badRequest('A destination with this name already exists');
    throw new Error(`Failed to create destination: ${error?.message}`);
  }
  return data as Destination;
}

export async function updateDestination(db: SupabaseClient, accountId: string, id: string, raw: unknown): Promise<Destination> {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof src.name === 'string' && src.name.trim()) {
    patch.name = src.name.trim().slice(0, 120);
    patch.slug = slugify(patch.name as string);
  }
  if ('parent_id' in src) patch.parent_id = typeof src.parent_id === 'string' && src.parent_id && src.parent_id !== id ? src.parent_id : null;
  if (Array.isArray(src.aliases)) patch.aliases = src.aliases.filter((a): a is string => typeof a === 'string').map((a) => a.trim().toLowerCase()).filter(Boolean);
  if ('active' in src) patch.active = Boolean(src.active);
  const { data, error } = await db.from('destinations').update(patch).eq('id', id).eq('account_id', accountId).select('*').single();
  if (error || !data) throw notFound('Destination');
  return data as Destination;
}

// ------------------------------------------------------------
// Suppliers
// ------------------------------------------------------------

export interface SupplierInput {
  name: string;
  company_name: string | null;
  primary_contact_name: string | null;
  phone: string | null;
  whatsapp_phone: string | null;
  email: string | null;
  status: SupplierStatus;
  supplier_type: SupplierType;
  rating: string | null;
  notes: string | null;
  payment_terms: string | null;
  preferred: boolean;
  active: boolean;
  /** Destination mappings to replace (omit = leave unchanged). */
  destinations?: { destination_id: string; priority?: number; preferred?: boolean; service_types?: string[] }[];
}

export function parseSupplierInput(raw: unknown, partial = false): Partial<SupplierInput> {
  if (typeof raw !== 'object' || raw === null) throw badRequest('Invalid supplier');
  const s = raw as Record<string, unknown>;
  const out: Partial<SupplierInput> = {};
  const text = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  if ('name' in s || !partial) {
    const name = text(s.name, 200);
    if (!name) throw badRequest('Supplier name is required');
    out.name = name;
  }
  if ('company_name' in s) out.company_name = text(s.company_name, 200);
  if ('primary_contact_name' in s) out.primary_contact_name = text(s.primary_contact_name, 200);
  for (const k of ['phone', 'whatsapp_phone'] as const) {
    if (k in s) {
      const v = text(s[k], 30);
      if (v) {
        const digits = sanitizePhoneForMeta(v);
        if (!isValidE164(digits)) throw badRequest(`${k === 'phone' ? 'Phone' : 'WhatsApp number'} must be a valid international number (e.g. 919876543210)`);
        out[k] = digits;
      } else out[k] = null;
    }
  }
  if ('email' in s) {
    const v = text(s.email, 200);
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw badRequest('Invalid email');
    out.email = v;
  }
  if ('status' in s) out.status = (['ACTIVE', 'INACTIVE', 'BLACKLISTED'] as SupplierStatus[]).includes(s.status as SupplierStatus) ? (s.status as SupplierStatus) : 'ACTIVE';
  if ('supplier_type' in s) out.supplier_type = (SUPPLIER_TYPES as readonly string[]).includes(String(s.supplier_type)) ? (s.supplier_type as SupplierType) : 'DMC';
  if ('rating' in s) {
    const n = s.rating === null || s.rating === '' ? null : Number(s.rating);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 5)) throw badRequest('Rating must be between 0 and 5');
    out.rating = n === null ? null : n.toFixed(2);
  }
  if ('notes' in s) out.notes = text(s.notes, 4000);
  if ('payment_terms' in s) out.payment_terms = text(s.payment_terms, 1000);
  if ('preferred' in s) out.preferred = Boolean(s.preferred);
  if ('active' in s) out.active = Boolean(s.active);
  if (Array.isArray(s.destinations)) {
    const destinations = s.destinations
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null && typeof d.destination_id === 'string')
      .map((d) => ({
        destination_id: d.destination_id as string,
        priority: typeof d.priority === 'number' ? Math.max(1, Math.min(999, Math.round(d.priority))) : 100,
        preferred: Boolean(d.preferred),
        service_types: Array.isArray(d.service_types) ? d.service_types.filter((t): t is string => typeof t === 'string').slice(0, 10) : [],
      }));
    if (new Set(destinations.map((d) => d.destination_id)).size > 3) throw badRequest('A supplier can serve a maximum of 3 destinations');
    out.destinations = destinations;
  }
  return out;
}

export async function listSuppliers(db: SupabaseClient, accountId: string, f: { q?: string | null; destinationId?: string | null; includeInactive?: boolean } = {}): Promise<Supplier[]> {
  let q = db
    .from('suppliers')
    .select('*, supplier_destinations(*, destination:destinations(id, name, slug, parent_id))')
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .order('preferred', { ascending: false })
    .order('name');
  if (!f.includeInactive) q = q.eq('active', true);
  if (f.q) q = q.or(`name.ilike.%${f.q}%,company_name.ilike.%${f.q}%,primary_contact_name.ilike.%${f.q}%`);
  const { data } = await q;
  let rows = (data ?? []) as Supplier[];
  if (f.destinationId) rows = rows.filter((s) => (s.supplier_destinations ?? []).some((m) => m.destination_id === f.destinationId && m.active));
  return rows;
}

export async function getSupplier(db: SupabaseClient, accountId: string, id: string): Promise<Supplier> {
  const { data } = await db
    .from('suppliers')
    .select('*, supplier_destinations(*, destination:destinations(id, name, slug, parent_id))')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!data) throw notFound('Supplier');
  return data as Supplier;
}

export async function createSupplier(db: SupabaseClient, accountId: string, raw: unknown, actorUserId: string | null): Promise<Supplier> {
  const input = parseSupplierInput(raw) as SupplierInput;
  const { destinations, ...fields } = input;
  const { data, error } = await db
    .from('suppliers')
    .insert({ account_id: accountId, created_by: actorUserId, ...fields })
    .select('*')
    .single();
  if (error || !data) throw new Error(`Failed to create supplier: ${error?.message}`);
  if (destinations) await replaceSupplierDestinations(db, accountId, data.id as string, destinations);
  return getSupplier(db, accountId, data.id as string);
}

export async function updateSupplier(db: SupabaseClient, accountId: string, id: string, raw: unknown): Promise<Supplier> {
  const input = parseSupplierInput(raw, true);
  const { destinations, ...fields } = input;
  await getSupplier(db, accountId, id);
  if (Object.keys(fields).length) {
    const { error } = await db.from('suppliers').update(fields).eq('id', id).eq('account_id', accountId);
    if (error) throw new Error(`Failed to update supplier: ${error.message}`);
  }
  if (destinations) await replaceSupplierDestinations(db, accountId, id, destinations);
  return getSupplier(db, accountId, id);
}

export async function softDeleteSupplier(db: SupabaseClient, accountId: string, id: string): Promise<void> {
  const { error } = await db.from('suppliers').update({ deleted_at: new Date().toISOString(), active: false, status: 'INACTIVE' }).eq('id', id).eq('account_id', accountId);
  if (error) throw new Error(`Failed to delete supplier: ${error.message}`);
}

/** Prefix marking a destination the catalog offers but this account has not seeded yet. */
export const CATALOG_ID_PREFIX = 'catalog:';

/**
 * Turn `catalog:<slug>` placeholders into real destination ids,
 * creating the row when it is missing.
 *
 * The supplier form offers the whole catalog whether or not an account
 * has seeded it, so an agent never has to notice that destinations are
 * a separate setup step. Creation goes through the service role
 * because `destinations` is settings-class (admin-only) while adding a
 * supplier is agent-level work. That is safe here precisely because
 * the slug must name a DEFAULT_DESTINATIONS entry — the set of rows a
 * caller can bring into existence is fixed in code, not supplied by
 * the request, and the account id comes from the session.
 */
async function resolveCatalogIds(accountId: string, ids: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const wanted = ids.filter((id) => id.startsWith(CATALOG_ID_PREFIX));
  if (wanted.length === 0) return resolved;

  const admin = supabaseAdmin();
  for (const placeholder of wanted) {
    const slug = placeholder.slice(CATALOG_ID_PREFIX.length);
    const entry = DEFAULT_DESTINATIONS.find((d) => slugify(d.name) === slug);
    if (!entry) continue; // not in the catalog — refuse rather than create

    const existing = await findDestinationIdBySlug(admin, accountId, slug);
    if (existing) {
      resolved.set(placeholder, existing);
      continue;
    }
    const { data: created, error } = await admin
      .from('destinations')
      .insert({ account_id: accountId, name: entry.name, slug, aliases: entry.aliases ?? [] })
      .select('id')
      .single();
    if (error || !created) {
      // Lost a race against a concurrent create — re-read the winner.
      const raced = await findDestinationIdBySlug(admin, accountId, slug);
      if (raced) resolved.set(placeholder, raced);
      continue;
    }
    resolved.set(placeholder, created.id as string);
  }
  return resolved;
}

async function findDestinationIdBySlug(
  admin: SupabaseClient,
  accountId: string,
  slug: string,
): Promise<string | null> {
  const { data } = await admin
    .from('destinations')
    .select('id')
    .eq('account_id', accountId)
    .eq('slug', slug)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

async function replaceSupplierDestinations(
  db: SupabaseClient,
  accountId: string,
  supplierId: string,
  mappings: NonNullable<SupplierInput['destinations']>
): Promise<void> {
  const catalogIds = await resolveCatalogIds(
    accountId,
    mappings.map((m) => m.destination_id),
  );
  mappings = mappings.map((m) =>
    catalogIds.has(m.destination_id) ? { ...m, destination_id: catalogIds.get(m.destination_id)! } : m,
  );

  const ids = [...new Set(mappings.map((m) => m.destination_id))];
  if (ids.length) {
    const { data: valid } = await db.from('destinations').select('id').eq('account_id', accountId).in('id', ids);
    const validIds = new Set((valid ?? []).map((v) => v.id as string));
    mappings = mappings.filter((m) => validIds.has(m.destination_id));
  }
  await db.from('supplier_destinations').delete().eq('supplier_id', supplierId).eq('account_id', accountId);
  if (mappings.length) {
    const seen = new Set<string>();
    const rows = mappings
      .filter((m) => (seen.has(m.destination_id) ? false : (seen.add(m.destination_id), true)))
      .map((m) => ({
        account_id: accountId,
        supplier_id: supplierId,
        destination_id: m.destination_id,
        priority: m.priority ?? 100,
        preferred: m.preferred ?? false,
        service_types: m.service_types ?? [],
        active: true,
      }));
    const { error } = await db.from('supplier_destinations').insert(rows);
    if (error) throw new Error(`Failed to save supplier destinations: ${error.message}`);
  }
}

export { DEFAULT_DESTINATIONS };
export type { SupplierDestination };
