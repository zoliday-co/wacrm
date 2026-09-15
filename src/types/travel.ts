// ============================================================
// Oliday travel domain types — mirror migrations 041–048.
//
// Money columns are NUMERIC in Postgres and arrive as *strings*
// through PostgREST. They are typed `string` here on purpose; use
// `@/lib/travel/money` to do arithmetic, never `Number()` in a
// component.
// ============================================================

import type { Contact, Conversation, Deal } from './index';

export const TRAVEL_LEAD_STATUSES = [
  'BOT_QUALIFYING',
  'QUALIFIED',
  'RFQ_SENT',
  'AWAITING_SUPPLIER_QUOTES',
  'QUOTES_AVAILABLE',
  'CALLBACK_REQUESTED',
  'HUMAN_FOLLOWUP',
  'REQUOTE',
  'NEGOTIATION',
  'BOOKING_CONFIRMED',
  'LOST',
] as const;
export type TravelLeadStatus = (typeof TRAVEL_LEAD_STATUSES)[number];

export type BudgetType = 'total' | 'per_person';
export type SourceType = 'meta_whatsapp_ad' | 'whatsapp_organic' | 'manual' | 'referral' | 'website' | string;

export interface TravelLead {
  id: string;
  account_id: string;
  deal_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  bot_session_id: string | null;
  source_type: SourceType;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  ad_id: string | null;
  ad_name: string | null;
  referral_data: Record<string, unknown> | null;
  traveller_name: string | null;
  destination_primary: string | null;
  destination_id: string | null;
  destinations: string[];
  departure_city: string | null;
  travel_start_date: string | null;
  travel_end_date: string | null;
  travel_month: string | null;
  dates_flexible: boolean;
  flexibility_days: number | null;
  nights: number | null;
  days: number | null;
  adults: number;
  children: number;
  infants: number;
  child_ages: number[];
  room_count: number | null;
  room_configuration: string | null;
  hotel_category: string | null;
  meal_plan: string | null;
  hotel_preferences: string[];
  vehicle_type: string | null;
  pickup_location: string | null;
  drop_location: string | null;
  budget_amount: string | null;
  budget_type: BudgetType | null;
  activities: string[];
  special_requests: string | null;
  qualification_summary: string | null;
  current_requirement_version: number;
  current_requirement_version_id: string | null;
  status: TravelLeadStatus;
  lost_reason: string | null;
  closed_at: string | null;
  assigned_agent_id: string | null;
  assigned_at: string | null;
  next_action_text: string | null;
  next_action_at: string | null;
  last_activity_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Hydrated by detail queries
  contact?: Contact | null;
  conversation?: Conversation | null;
  deal?: Deal | null;
  assigned_agent?: { user_id: string; full_name: string; avatar_url: string | null } | null;
}

export interface TravelRequirementVersion {
  id: string;
  account_id: string;
  travel_lead_id: string;
  version: number;
  destination_primary: string | null;
  destinations: string[];
  departure_city: string | null;
  travel_start_date: string | null;
  travel_end_date: string | null;
  travel_month: string | null;
  dates_flexible: boolean;
  flexibility_days: number | null;
  nights: number | null;
  days: number | null;
  adults: number;
  children: number;
  infants: number;
  child_ages: number[];
  room_count: number | null;
  room_configuration: string | null;
  hotel_category: string | null;
  meal_plan: string | null;
  hotel_preferences: string[];
  vehicle_type: string | null;
  pickup_location: string | null;
  drop_location: string | null;
  budget_amount: string | null;
  budget_type: BudgetType | null;
  activities: string[];
  special_requests: string | null;
  change_reason: string | null;
  created_by: string | null;
  created_at: string;
}

/** The editable requirement fields (what an agent changes on re-quote). */
export type RequirementInput = Partial<
  Omit<
    TravelRequirementVersion,
    'id' | 'account_id' | 'travel_lead_id' | 'version' | 'created_by' | 'created_at'
  >
>;

export type LeadEventActor = 'system' | 'agent' | 'bot' | 'supplier' | 'traveller';

export interface TravelLeadEvent {
  id: string;
  account_id: string;
  travel_lead_id: string;
  event_type: string;
  actor_type: LeadEventActor;
  actor_user_id: string | null;
  title: string;
  details: Record<string, unknown>;
  old_value: unknown | null;
  new_value: unknown | null;
  created_at: string;
}

export interface TravelSettings {
  id: string;
  account_id: string;
  pipeline_id: string | null;
  currency: string;
  max_suppliers_per_rfq: number;
  min_quotes_before_notification: number;
  rfq_deadline_hours: number;
  supplier_quote_token_ttl_hours: number;
  supplier_reminder_hours: number;
  supplier_max_reminders: number;
  auto_send_rfq: boolean;
  auto_notify_traveller: boolean;
  supplier_rfq_template_name: string | null;
  supplier_rfq_template_language: string | null;
  traveller_quotes_ready_template_name: string | null;
  traveller_quotes_ready_template_language: string | null;
  callback_token_ttl_hours: number;
  gst_rate: string;
  gst_taxable_base: GstTaxableBase;
  default_markup_type: MarkupType;
  default_markup_value: string;
  margin_warning_pct: string;
  margin_approval_pct: string | null;
  traveller_quote_validity_days: number;
  created_at: string;
  updated_at: string;
}

export type GstTaxableBase = 'selling_price' | 'markup';
export type MarkupType = 'percent' | 'fixed';

export interface Destination {
  id: string;
  account_id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  aliases: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
  children?: Destination[];
}

export const SUPPLIER_TYPES = [
  'DMC',
  'HOTEL',
  'TRANSPORTER',
  'ACTIVITY_PROVIDER',
  'GUIDE',
  'MULTI_SERVICE',
] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];
export type SupplierStatus = 'ACTIVE' | 'INACTIVE' | 'BLACKLISTED';

export interface Supplier {
  id: string;
  account_id: string;
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
  contact_id: string | null;
  metadata: Record<string, unknown>;
  deleted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  supplier_destinations?: SupplierDestination[];
}

export interface SupplierDestination {
  id: string;
  account_id: string;
  supplier_id: string;
  destination_id: string;
  priority: number;
  preferred: boolean;
  active: boolean;
  service_types: string[];
  created_at: string;
  destination?: Destination | null;
}

export type RfqStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_RESPONDED' | 'RESPONDED' | 'CLOSED' | 'CANCELLED';

export interface Rfq {
  id: string;
  account_id: string;
  travel_lead_id: string;
  requirement_version_id: string | null;
  version: number;
  status: RfqStatus;
  recipient_count: number;
  response_count: number;
  traveller_notified_at: string | null;
  sent_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  rfq_suppliers?: RfqSupplier[];
  travel_lead?: Pick<TravelLead, 'id' | 'traveller_name' | 'destination_primary' | 'status' | 'nights' | 'adults' | 'children'> | null;
}

export type RfqSupplierStatus = 'PENDING' | 'SENT' | 'RESPONDED' | 'DECLINED' | 'EXPIRED' | 'SELECTED' | 'REJECTED';

export interface RfqSupplier {
  id: string;
  account_id: string;
  rfq_id: string;
  supplier_id: string;
  status: RfqSupplierStatus;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  responded_at: string | null;
  reminder_count: number;
  last_reminder_at: string | null;
  send_error: string | null;
  send_attempts: number;
  sent_message_id: string | null;
  quote_token_expires_at: string | null;
  quote_token_revoked_at: string | null;
  latest_quote_id: string | null;
  created_at: string;
  updated_at: string;
  supplier?: Supplier | null;
  latest_quote?: SupplierQuote | null;
}

export type SupplierQuoteStatus = 'DRAFT' | 'SUBMITTED' | 'REVISED' | 'SHORTLISTED' | 'SELECTED' | 'REJECTED' | 'EXPIRED';

export interface SupplierQuoteHotel {
  name: string;
  location?: string;
  room_category?: string;
  nights?: number;
  meal_plan?: string;
}

export interface SupplierQuote {
  id: string;
  account_id: string;
  rfq_id: string;
  rfq_supplier_id: string;
  supplier_id: string;
  travel_lead_id: string;
  version: number;
  currency: string;
  hotel_cost: string;
  transport_cost: string;
  activities_cost: string;
  other_cost: string;
  subtotal: string;
  supplier_tax_amount: string;
  total_supplier_cost: string;
  hotel_details: SupplierQuoteHotel[];
  transport_details: { vehicle?: string; notes?: string } & Record<string, unknown>;
  activity_details: { name: string; notes?: string }[];
  inclusions: string | null;
  exclusions: string | null;
  cancellation_policy: string | null;
  valid_until: string | null;
  supplier_notes: string | null;
  status: SupplierQuoteStatus;
  internal_notes: string | null;
  submitted_at: string;
  response_seconds: number | null;
  created_at: string;
  updated_at: string;
  supplier?: Supplier | null;
  items?: SupplierQuoteItem[];
}

export const SUPPLIER_QUOTE_ITEM_CATEGORIES = [
  'HOTEL', 'CAB', 'HOUSEBOAT', 'ACTIVITY', 'TRANSFER', 'MEAL', 'GUIDE', 'OTHER',
] as const;
export type SupplierQuoteItemCategory = (typeof SUPPLIER_QUOTE_ITEM_CATEGORIES)[number];

export interface SupplierQuoteItem {
  id: string;
  account_id: string;
  supplier_quote_id: string;
  category: SupplierQuoteItemCategory;
  description: string;
  day_number: number | null;
  quantity: string;
  unit_cost: string;
  amount: string;
  metadata: Record<string, unknown>;
  sort_order: number;
  created_at: string;
}

export type TravellerQuoteStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'REVISED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

export interface TravellerQuote {
  id: string;
  account_id: string;
  travel_lead_id: string;
  supplier_quote_id: string | null;
  version: number;
  title: string | null;
  currency: string;
  supplier_cost: string;
  markup_type: MarkupType;
  markup_value: string;
  markup_amount: string;
  discount_amount: string;
  discount_reason: string | null;
  selling_price_before_tax: string;
  gst_rate: string;
  gst_taxable_base: GstTaxableBase;
  gst_taxable_amount: string;
  gst_amount: string;
  traveller_total: string;
  gross_profit: string;
  margin_pct: string;
  inclusions: string | null;
  exclusions: string | null;
  cancellation_policy: string | null;
  notes: string | null;
  revision_reason: string | null;
  status: TravellerQuoteStatus;
  approval_status: ApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
  valid_until: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  sent_message_id: string | null;
  send_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  supplier_quote?: SupplierQuote | null;
}

export type ItineraryStatus = 'DRAFT' | 'FINAL' | 'ARCHIVED';

export interface Itinerary {
  id: string;
  account_id: string;
  travel_lead_id: string;
  traveller_quote_id: string | null;
  version: number;
  title: string;
  summary: string | null;
  hero_image_url: string | null;
  status: ItineraryStatus;
  generated_by: string;
  extras: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  days?: ItineraryDay[];
}

export interface ItineraryDay {
  id: string;
  account_id: string;
  itinerary_id: string;
  day_number: number;
  date: string | null;
  title: string;
  description: string | null;
  hotel: string | null;
  meals: string | null;
  transport: string | null;
  activities: string[];
  sort_order: number;
  created_at: string;
}

export type InteractionType = 'CALL' | 'NOTE' | 'FOLLOW_UP' | 'MEETING' | 'SYSTEM';

export interface LeadInteraction {
  id: string;
  account_id: string;
  travel_lead_id: string;
  interaction_type: InteractionType;
  agent_id: string | null;
  summary: string;
  details: string | null;
  outcome: string | null;
  duration_seconds: number | null;
  occurred_at: string;
  next_follow_up_at: string | null;
  created_at: string;
  updated_at: string;
  agent?: { user_id: string; full_name: string } | null;
}

export type TaskType = 'GENERAL' | 'CALL' | 'FOLLOW_UP' | 'CALLBACK' | 'SUPPLIER' | 'PAYMENT' | 'OPERATIONS';
export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';

export interface TravelTask {
  id: string;
  account_id: string;
  travel_lead_id: string | null;
  booking_id: string | null;
  title: string;
  description: string | null;
  task_type: TaskType;
  assigned_to: string | null;
  priority: TaskPriority;
  due_at: string | null;
  status: TaskStatus;
  remind_at: string | null;
  reminded_at: string | null;
  source_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  travel_lead?: Pick<TravelLead, 'id' | 'traveller_name' | 'destination_primary'> | null;
}

export type CallbackWindow = 'NOW' | 'MORNING' | 'AFTERNOON' | 'EVENING' | 'SPECIFIC';
export type CallbackStatus = 'REQUESTED' | 'SCHEDULED' | 'COMPLETED' | 'MISSED' | 'CANCELLED';

export interface CallbackRequest {
  id: string;
  account_id: string;
  travel_lead_id: string;
  preferred_date: string | null;
  preferred_time: string | null;
  time_window: CallbackWindow | null;
  scheduled_at: string | null;
  traveller_note: string | null;
  status: CallbackStatus;
  assigned_agent_id: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type BookingStatus = 'CONFIRMED' | 'PARTIALLY_PAID' | 'FULLY_PAID' | 'UPCOMING' | 'ONGOING' | 'COMPLETED' | 'CANCELLED';

export interface Booking {
  id: string;
  account_id: string;
  booking_number: string;
  travel_lead_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  selected_supplier_id: string | null;
  supplier_quote_id: string | null;
  traveller_quote_id: string | null;
  itinerary_id: string | null;
  traveller_name: string | null;
  destination_primary: string | null;
  travel_start_date: string | null;
  travel_end_date: string | null;
  nights: number | null;
  adults: number;
  children: number;
  infants: number;
  status: BookingStatus;
  currency: string;
  supplier_cost: string;
  markup_amount: string;
  discount_amount: string;
  selling_price_before_tax: string;
  gst_rate: string;
  gst_taxable_amount: string;
  gst_amount: string;
  traveller_total: string;
  gross_profit: string;
  margin_pct: string;
  amount_received: string;
  customer_balance: string;
  supplier_amount_paid: string;
  supplier_balance: string;
  financial_snapshot: Record<string, unknown>;
  itinerary_snapshot: unknown | null;
  requirement_snapshot: unknown | null;
  supplier_quote_snapshot: unknown | null;
  cancellation_reason: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  supplier?: Supplier | null;
  contact?: Contact | null;
  customer_payments?: CustomerPayment[];
  supplier_payments?: SupplierPayment[];
  items?: BookingItem[];
}

export type PaymentMethod = 'UPI' | 'BANK_TRANSFER' | 'PAYMENT_GATEWAY' | 'CASH' | 'CARD' | 'OTHER';
export type CustomerPaymentStatus = 'PENDING' | 'RECEIVED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
export type SupplierPaymentStatus = 'SCHEDULED' | 'PAID' | 'FAILED' | 'CANCELLED';

export interface CustomerPayment {
  id: string;
  account_id: string;
  booking_id: string;
  amount: string;
  currency: string;
  payment_method: PaymentMethod;
  transaction_reference: string | null;
  payment_status: CustomerPaymentStatus;
  refunded_amount: string;
  payment_date: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  booking?: Pick<Booking, 'id' | 'booking_number' | 'traveller_name'> | null;
}

export interface SupplierPayment {
  id: string;
  account_id: string;
  booking_id: string;
  supplier_id: string | null;
  amount: string;
  currency: string;
  payment_method: PaymentMethod;
  transaction_reference: string | null;
  status: SupplierPaymentStatus;
  due_date: string | null;
  paid_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  booking?: Pick<Booking, 'id' | 'booking_number' | 'traveller_name'> | null;
  supplier?: Pick<Supplier, 'id' | 'name'> | null;
}

export interface BookingItem {
  id: string;
  account_id: string;
  booking_id: string;
  category: string;
  title: string;
  description: string | null;
  supplier_id: string | null;
  start_date: string | null;
  end_date: string | null;
  confirmation_number: string | null;
  status: 'PENDING' | 'REQUESTED' | 'CONFIRMED' | 'CANCELLED';
  amount: string | null;
  details: Record<string, unknown>;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** One row of the merged lead timeline (events + interactions + messages). */
export interface TimelineEntry {
  id: string;
  kind: 'event' | 'interaction' | 'message';
  at: string;
  title: string;
  body?: string | null;
  actor?: string | null;
  event_type?: string;
  details?: Record<string, unknown>;
}
