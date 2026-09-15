// ============================================================
// Travel-layer constants: pipeline stage definitions, status
// labels/colours, and the lead-status → deal-stage mapping.
// Pure — safe to import from client and server code.
// ============================================================

import type { TravelLeadStatus } from '@/types/travel';

export const TRAVEL_PIPELINE_NAME = 'Oliday Travel';

/** Ordered Oliday pipeline stages. `key` is stored on pipeline_stages.stage_key. */
export const TRAVEL_STAGES: { key: TravelLeadStatus; name: string; color: string }[] = [
  { key: 'BOT_QUALIFYING', name: 'Bot Qualifying', color: '#94a3b8' },
  { key: 'QUALIFIED', name: 'Qualified', color: '#3b82f6' },
  { key: 'RFQ_SENT', name: 'RFQ Sent', color: '#6366f1' },
  { key: 'AWAITING_SUPPLIER_QUOTES', name: 'Awaiting Supplier Quotes', color: '#8b5cf6' },
  { key: 'QUOTES_AVAILABLE', name: 'Quotes Available', color: '#a855f7' },
  { key: 'CALLBACK_REQUESTED', name: 'Callback Requested', color: '#ec4899' },
  { key: 'HUMAN_FOLLOWUP', name: 'Human Follow-up', color: '#f97316' },
  { key: 'REQUOTE', name: 'Re-quote', color: '#eab308' },
  { key: 'NEGOTIATION', name: 'Negotiation', color: '#f59e0b' },
  { key: 'BOOKING_CONFIRMED', name: 'Booking Confirmed', color: '#22c55e' },
  { key: 'LOST', name: 'Lost', color: '#ef4444' },
];

export const LEAD_STATUS_LABEL: Record<TravelLeadStatus, string> = Object.fromEntries(
  TRAVEL_STAGES.map((s) => [s.key, s.name])
) as Record<TravelLeadStatus, string>;

export const LEAD_STATUS_COLOR: Record<TravelLeadStatus, string> = Object.fromEntries(
  TRAVEL_STAGES.map((s) => [s.key, s.color])
) as Record<TravelLeadStatus, string>;

/** Statuses that count as "open" for dashboards. */
export const OPEN_LEAD_STATUSES: TravelLeadStatus[] = [
  'BOT_QUALIFYING',
  'QUALIFIED',
  'RFQ_SENT',
  'AWAITING_SUPPLIER_QUOTES',
  'QUOTES_AVAILABLE',
  'CALLBACK_REQUESTED',
  'HUMAN_FOLLOWUP',
  'REQUOTE',
  'NEGOTIATION',
];

/** Statuses at which a human is (or should be) actively involved. */
export const HUMAN_STAGE_STATUSES: TravelLeadStatus[] = [
  'CALLBACK_REQUESTED',
  'HUMAN_FOLLOWUP',
  'REQUOTE',
  'NEGOTIATION',
];

export const HOTEL_CATEGORIES = [
  { value: '2_star', label: '2 Star' },
  { value: '3_star', label: '3 Star' },
  { value: '4_star', label: '4 Star' },
  { value: '5_star', label: '5 Star' },
  { value: 'luxury', label: 'Luxury' },
  { value: 'homestay', label: 'Homestay' },
  { value: 'resort', label: 'Resort' },
  { value: 'any', label: 'Any' },
] as const;

export const MEAL_PLANS = [
  { value: 'EP', label: 'EP — Room only' },
  { value: 'CP', label: 'CP — Breakfast' },
  { value: 'MAP', label: 'MAP — Breakfast + Dinner' },
  { value: 'AP', label: 'AP — All meals' },
] as const;

export const VEHICLE_TYPES = [
  'Sedan',
  'Innova',
  'Innova Crysta',
  'Ertiga',
  'Tempo Traveller',
  'Mini Bus',
  'Self-drive',
  'No vehicle',
] as const;

/** Human-readable hotel category label ("4_star" → "4 Star"). */
export function hotelCategoryLabel(value: string | null | undefined): string {
  if (!value) return '—';
  const found = HOTEL_CATEGORIES.find((h) => h.value === value);
  if (found) return found.label;
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Event types written to travel_lead_events (single vocabulary). */
export const LEAD_EVENT_TYPES = {
  LEAD_CREATED: 'lead_created',
  LEAD_QUALIFIED: 'lead_qualified',
  LEAD_ASSIGNED: 'lead_assigned',
  STATUS_CHANGED: 'status_changed',
  REQUIREMENT_MODIFIED: 'requirement_modified',
  RFQ_GENERATED: 'rfq_generated',
  RFQ_SENT: 'rfq_sent',
  RFQ_SUPPLIER_ADDED: 'rfq_supplier_added',
  RFQ_SUPPLIER_REMOVED: 'rfq_supplier_removed',
  RFQ_SEND_FAILED: 'rfq_send_failed',
  RFQ_REMINDER_SENT: 'rfq_reminder_sent',
  RFQ_EXPIRED: 'rfq_expired',
  SUPPLIER_QUOTE_RECEIVED: 'supplier_quote_received',
  SUPPLIER_QUOTE_REVISED: 'supplier_quote_revised',
  SUPPLIER_QUOTE_STATUS: 'supplier_quote_status_changed',
  SUPPLIER_SELECTED: 'supplier_selected',
  SUPPLIER_DECLINED: 'supplier_declined',
  TRAVELLER_NOTIFIED: 'traveller_notified',
  TRAVELLER_NOTIFY_FAILED: 'traveller_notify_failed',
  CALLBACK_REQUESTED: 'callback_requested',
  CALLBACK_COMPLETED: 'callback_completed',
  CUSTOMER_CALLED: 'customer_called',
  NOTE_ADDED: 'note_added',
  TRAVELLER_QUOTE_GENERATED: 'traveller_quote_generated',
  TRAVELLER_QUOTE_REVISED: 'traveller_quote_revised',
  TRAVELLER_QUOTE_SENT: 'traveller_quote_sent',
  TRAVELLER_QUOTE_SEND_FAILED: 'traveller_quote_send_failed',
  TRAVELLER_QUOTE_VIEWED: 'traveller_quote_viewed',
  TRAVELLER_QUOTE_ACCEPTED: 'traveller_quote_accepted',
  TRAVELLER_QUOTE_REJECTED: 'traveller_quote_rejected',
  TRAVELLER_CHANGE_REQUESTED: 'traveller_change_requested',
  DISCOUNT_CHANGED: 'discount_changed',
  QUOTE_APPROVAL_REQUESTED: 'quote_approval_requested',
  QUOTE_APPROVED: 'quote_approved',
  BOOKING_CREATED: 'booking_created',
  BOOKING_STATUS: 'booking_status_changed',
  BOOKING_CANCELLED: 'booking_cancelled',
  CUSTOMER_PAYMENT_RECEIVED: 'customer_payment_received',
  SUPPLIER_PAYMENT_MADE: 'supplier_payment_made',
  TASK_CREATED: 'task_created',
  TASK_COMPLETED: 'task_completed',
  ITINERARY_CREATED: 'itinerary_created',
} as const;

export type LeadEventType = (typeof LEAD_EVENT_TYPES)[keyof typeof LEAD_EVENT_TYPES];
