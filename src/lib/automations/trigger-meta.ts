import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  label: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    label: 'New Message',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
  first_inbound_message: {
    label: 'First Message from Contact',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  },
  keyword_match: {
    label: 'Keyword Match',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  },
  new_contact_created: {
    label: 'New Contact',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    label: 'Conversation Assigned',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  },
  tag_added: {
    label: 'Tag Added',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  time_based: {
    label: 'Time-Based',
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  },
  interactive_reply: {
    label: 'Button / List Reply',
    pillClass: 'border-pink-500/30 bg-pink-500/10 text-pink-300',
  },
  travel_lead_qualified: { label: 'Travel Lead Qualified', pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  travel_rfq_sent: { label: 'RFQ Sent', pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  supplier_quote_received: { label: 'Supplier Quote Received', pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  minimum_supplier_quotes_received: { label: 'Quotes Ready for Traveller', pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  traveller_callback_requested: { label: 'Callback Requested', pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  traveller_quote_sent: { label: 'Traveller Quote Sent', pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  traveller_quote_accepted: { label: 'Traveller Quote Accepted', pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  booking_created: { label: 'Booking Created', pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  payment_due: { label: 'Payment Due', pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
}

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? {
      label: t,
      pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
    }
  )
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 2_592_000) return `${Math.floor(diffSec / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}
