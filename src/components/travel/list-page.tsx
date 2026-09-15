'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from './status-badge';
import { formatMoney } from '@/lib/travel/money';
import { fmtDate, fmtDateTime } from '@/lib/travel/format';

type Row = Record<string, unknown>;
type Kind = 'leads' | 'rfqs' | 'bookings' | 'itineraries' | 'payments' | 'followups';

const CONFIG: Record<Kind, { title: string; subtitle: string; endpoint: string }> = {
  leads: { title: 'Travel leads', subtitle: 'Qualified WhatsApp enquiries and active sales work', endpoint: '/api/travel/leads?status=all' },
  rfqs: { title: 'Supplier RFQs', subtitle: 'Requirements sent to destination suppliers', endpoint: '/api/travel/rfqs' },
  bookings: { title: 'Bookings', subtitle: 'Confirmed trips and their payment position', endpoint: '/api/travel/bookings?status=all' },
  itineraries: { title: 'Itineraries', subtitle: 'All saved itinerary versions', endpoint: '/api/travel/itineraries' },
  payments: { title: 'Payments', subtitle: 'Customer receipts and supplier payouts', endpoint: '/api/travel/payments' },
  followups: { title: 'Follow-ups', subtitle: 'Calls, callbacks, supplier work and payment tasks', endpoint: '/api/travel/tasks?status=open' },
};

function rowsFor(kind: Kind, payload: Row): Row[] {
  if (kind === 'payments') return [...((payload.customer as Row[] | undefined) ?? []).map((r) => ({ ...r, payment_kind: 'Customer' })), ...((payload.supplier as Row[] | undefined) ?? []).map((r) => ({ ...r, payment_kind: 'Supplier' }))];
  const key = kind === 'followups' ? 'tasks' : kind;
  return (payload[key] as Row[] | undefined) ?? [];
}

function text(row: Row, ...keys: string[]) {
  for (const key of keys) if (typeof row[key] === 'string' && row[key]) return row[key] as string;
  return null;
}

export function TravelListPage({ kind }: { kind: Kind }) {
  const config = CONFIG[kind];
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    fetch(config.endpoint).then(async (r) => { const body = await r.json() as Row; if (!r.ok) throw new Error(text(body, 'error') ?? 'Could not load data'); return body; }).then((body) => setRows(rowsFor(kind, body))).catch((e: Error) => setError(e.message));
  };
  // Initial network synchronization; state updates happen from the fetch callbacks.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(load, [config.endpoint, kind]);

  return <div className="space-y-6">
    <div className="flex items-start justify-between gap-4"><div><h1 className="text-2xl font-bold">{config.title}</h1><p className="mt-1 text-sm text-muted-foreground">{config.subtitle}</p></div><Button variant="outline" onClick={load}><RefreshCw />Refresh</Button></div>
    {error ? <Card><CardContent className="text-destructive">{error}</CardContent></Card> : rows === null ? <div className="flex h-48 items-center justify-center"><Loader2 className="animate-spin" /></div> : rows.length === 0 ? <Card><CardContent className="py-12 text-center text-muted-foreground">No records yet. New activity will appear here automatically.</CardContent></Card> : <div className="grid gap-3">
      {rows.map((row) => {
        const id = String(row.id);
        const title = kind === 'leads' ? text(row, 'traveller_name') ?? 'Unnamed traveller' : kind === 'bookings' ? text(row, 'booking_number') ?? 'Booking' : kind === 'rfqs' ? `RFQ V${String(row.version ?? 1)}` : kind === 'itineraries' ? text(row, 'title') ?? 'Itinerary' : kind === 'followups' ? text(row, 'title') ?? 'Task' : `${text(row, 'payment_kind') ?? 'Payment'} payment`;
        const leadId = text(row, 'travel_lead_id');
        const href = kind === 'leads' ? `/leads/${id}` : kind === 'bookings' ? `/bookings/${id}` : leadId ? `/leads/${leadId}` : undefined;
        const destination = text(row, 'destination_primary');
        const amount = text(row, 'traveller_total', 'amount', 'total_supplier_cost');
        const status = text(row, 'status', 'payment_status');
        const content = <Card className="transition-colors hover:bg-muted/20"><CardContent className="flex items-center gap-4"><div className="min-w-0 flex-1"><p className="font-semibold">{title}</p><p className="mt-1 text-sm text-muted-foreground">{[destination, text(row, 'traveller_name'), row.due_at ? fmtDateTime(String(row.due_at)) : null, row.travel_start_date ? fmtDate(String(row.travel_start_date)) : null].filter(Boolean).join(' • ') || 'Oliday travel operation'}</p></div>{amount ? <span className="font-semibold tabular-nums">{formatMoney(amount)}</span> : null}{status ? <StatusBadge value={status} /> : null}</CardContent></Card>;
        return href ? <Link key={id} href={href}>{content}</Link> : <div key={id}>{content}</div>;
      })}
    </div>}
  </div>;
}
