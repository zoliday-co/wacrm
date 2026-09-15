import { Badge } from '@/components/ui/badge';

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const label = (value ?? 'UNKNOWN').replaceAll('_', ' ');
  const positive = ['QUALIFIED', 'QUOTES_AVAILABLE', 'BOOKING_CONFIRMED', 'ACCEPTED', 'SELECTED', 'COMPLETED', 'FULLY_PAID', 'RESPONDED'].includes(value ?? '');
  const warning = ['RFQ_SENT', 'AWAITING_SUPPLIER_QUOTES', 'CALLBACK_REQUESTED', 'NEGOTIATION', 'PARTIALLY_PAID', 'SENT', 'PENDING'].includes(value ?? '');
  return <Badge variant={positive ? 'default' : warning ? 'secondary' : value === 'LOST' || value === 'CANCELLED' || value === 'REJECTED' ? 'destructive' : 'outline'}>{label}</Badge>;
}
