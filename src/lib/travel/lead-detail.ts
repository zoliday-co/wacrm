// ============================================================
// The "10-second" lead detail payload — everything the agent
// needs in one round trip: lead + contact + conversation +
// requirement versions + RFQs/recipients + supplier quotes +
// traveller quotes + itineraries + interactions + tasks +
// callbacks + bookings + next action + a pricing preview.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Contact, Conversation, Deal, Message } from '@/types';
import type {
  Booking,
  CallbackRequest,
  Itinerary,
  LeadInteraction,
  Rfq,
  SupplierQuote,
  TravellerQuote,
  TravelLead,
  TravelRequirementVersion,
  TravelSettings,
  TravelTask,
} from '@/types/travel';
import { getLead } from './leads';
import { listRequirementVersions } from './requirements';
import { listSupplierQuotesForLead } from './supplier-quotes';
import { listTravellerQuotes } from './traveller-quotes';
import { listItineraries } from './itineraries';
import { listInteractions } from './interactions';
import { listTasks } from './tasks';
import { getTravelSettings } from './settings';
import { computeQuote, marginLevel } from './financials';
import { compare, toMinor } from './money';

export interface LeadDetail {
  lead: TravelLead;
  contact: Contact | null;
  conversation: Conversation | null;
  deal: Deal | null;
  assigned_agent: { user_id: string; full_name: string; avatar_url: string | null } | null;
  requirement_versions: TravelRequirementVersion[];
  rfqs: Rfq[];
  supplier_quotes: SupplierQuote[];
  traveller_quotes: TravellerQuote[];
  itineraries: Itinerary[];
  interactions: LeadInteraction[];
  tasks: TravelTask[];
  callbacks: CallbackRequest[];
  bookings: Booking[];
  recent_messages: Message[];
  settings: TravelSettings;
  members: { user_id: string; full_name: string; avatar_url: string | null; account_role: string }[];
  /** Quick pricing preview: lowest live supplier quote + default markup. */
  pricing_preview: {
    lowest_supplier_quote_id: string | null;
    supplier_cost: string;
    traveller_total: string;
    gross_profit: string;
    margin_pct: string;
    margin_level: 'ok' | 'warning' | 'approval_required';
  } | null;
}

export async function getLeadDetail(db: SupabaseClient, accountId: string, leadId: string, currentUserId: string): Promise<LeadDetail> {
  const lead = await getLead(db, accountId, leadId);
  const [
    contactRes,
    conversationRes,
    dealRes,
    agentRes,
    requirementVersions,
    rfqsRes,
    supplierQuotes,
    travellerQuotes,
    itineraries,
    interactions,
    tasks,
    callbacksRes,
    bookingsRes,
    messagesRes,
    settings,
    membersRes,
  ] = await Promise.all([
    lead.contact_id ? db.from('contacts').select('*').eq('id', lead.contact_id).maybeSingle() : Promise.resolve({ data: null }),
    lead.conversation_id ? db.from('conversations').select('*').eq('id', lead.conversation_id).maybeSingle() : Promise.resolve({ data: null }),
    lead.deal_id ? db.from('deals').select('*, stage:pipeline_stages(*)').eq('id', lead.deal_id).maybeSingle() : Promise.resolve({ data: null }),
    lead.assigned_agent_id ? db.from('profiles').select('user_id, full_name, avatar_url').eq('user_id', lead.assigned_agent_id).maybeSingle() : Promise.resolve({ data: null }),
    listRequirementVersions(db, accountId, leadId),
    db
      .from('rfqs')
      .select('*, rfq_suppliers(*, supplier:suppliers(id, name, company_name, rating, preferred, supplier_type, whatsapp_phone), latest_quote:supplier_quotes!rfq_suppliers_latest_quote_fkey(id, version, total_supplier_cost, status, submitted_at))')
      .eq('account_id', accountId)
      .eq('travel_lead_id', leadId)
      .order('version', { ascending: false }),
    listSupplierQuotesForLead(db, accountId, leadId),
    listTravellerQuotes(db, accountId, leadId),
    listItineraries(db, accountId, leadId),
    listInteractions(db, accountId, leadId),
    listTasks(db, accountId, { leadId, status: 'all', limit: 100 }, currentUserId),
    db.from('callback_requests').select('*').eq('account_id', accountId).eq('travel_lead_id', leadId).order('created_at', { ascending: false }),
    db.from('bookings').select('*, supplier:suppliers(id, name)').eq('account_id', accountId).eq('travel_lead_id', leadId).order('created_at', { ascending: false }),
    lead.conversation_id
      ? db.from('messages').select('*').eq('conversation_id', lead.conversation_id).order('created_at', { ascending: false }).limit(30)
      : Promise.resolve({ data: [] as Message[] }),
    getTravelSettings(db, accountId),
    db.from('profiles').select('user_id, full_name, avatar_url, account_role').eq('account_id', accountId).in('account_role', ['owner', 'admin', 'agent']),
  ]);

  const liveQuotes = supplierQuotes.filter((q) => ['SUBMITTED', 'SHORTLISTED', 'SELECTED'].includes(q.status));
  let pricingPreview: LeadDetail['pricing_preview'] = null;
  if (liveQuotes.length) {
    const lowest = liveQuotes.reduce((a, b) => (compare(toMinor(b.total_supplier_cost), toMinor(a.total_supplier_cost)) < 0 ? b : a));
    const latestTq = travellerQuotes[0];
    const breakdown = computeQuote({
      supplierCost: latestTq?.supplier_cost ?? lowest.total_supplier_cost,
      markupType: latestTq?.markup_type ?? settings.default_markup_type,
      markupValue: latestTq?.markup_value ?? settings.default_markup_value,
      discountAmount: latestTq?.discount_amount ?? 0,
      gstRate: latestTq?.gst_rate ?? settings.gst_rate,
      gstTaxableBase: latestTq?.gst_taxable_base ?? settings.gst_taxable_base,
    });
    pricingPreview = {
      lowest_supplier_quote_id: lowest.id,
      supplier_cost: breakdown.supplier_cost,
      traveller_total: breakdown.traveller_total,
      gross_profit: breakdown.gross_profit,
      margin_pct: breakdown.margin_pct,
      margin_level: marginLevel(breakdown.margin_pct, settings.margin_warning_pct, settings.margin_approval_pct),
    };
  }

  return {
    lead,
    contact: (contactRes.data as Contact | null) ?? null,
    conversation: (conversationRes.data as Conversation | null) ?? null,
    deal: (dealRes.data as Deal | null) ?? null,
    assigned_agent: (agentRes.data as LeadDetail['assigned_agent']) ?? null,
    requirement_versions: requirementVersions,
    rfqs: (rfqsRes.data ?? []) as Rfq[],
    supplier_quotes: supplierQuotes,
    traveller_quotes: travellerQuotes,
    itineraries,
    interactions,
    tasks,
    callbacks: (callbacksRes.data ?? []) as CallbackRequest[],
    bookings: (bookingsRes.data ?? []) as Booking[],
    recent_messages: ((messagesRes.data ?? []) as Message[]).reverse(),
    settings,
    members: (membersRes.data ?? []) as LeadDetail['members'],
    pricing_preview: pricingPreview,
  };
}
