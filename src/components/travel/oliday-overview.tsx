'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney } from '@/lib/travel/money';

interface Summary {
  cards: { new_qualified: number; awaiting_quotes: number; quotes_ready: number; callbacks_today: number; overdue_followups: number; bookings_this_month: number; revenue_this_month: string; gross_profit_this_month: string };
  needs_attention: { lead_id: string; traveller_name: string | null; destination: string | null; reason: string }[];
}

export function OlidayOverview() {
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => { void fetch('/api/travel/dashboard').then((r) => r.ok ? r.json() : null).then((v: Summary | null) => setSummary(v)); }, []);
  if (!summary) return <Card><CardContent className="py-6 text-sm text-muted-foreground">Loading Oliday operations…</CardContent></Card>;
  const cards = [
    ['New qualified', summary.cards.new_qualified, '/leads?status=QUALIFIED'],
    ['Waiting for quotes', summary.cards.awaiting_quotes, '/rfqs'],
    ['Quotes ready', summary.cards.quotes_ready, '/leads?status=QUOTES_AVAILABLE'],
    ['Callbacks today', summary.cards.callbacks_today, '/followups'],
    ['Overdue follow-ups', summary.cards.overdue_followups, '/followups'],
    ['Bookings this month', summary.cards.bookings_this_month, '/bookings'],
    ['Revenue this month', formatMoney(summary.cards.revenue_this_month), '/reports'],
    ['Gross profit this month', formatMoney(summary.cards.gross_profit_this_month), '/reports'],
  ] as const;
  return <section className="space-y-3"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Oliday operations</h2><Link className="text-sm text-primary hover:underline" href="/leads">Open all leads</Link></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([label, value, href]) => <Link href={href} key={label}><Card size="sm" className="h-full hover:bg-muted/20"><CardHeader><CardTitle className="text-sm text-muted-foreground">{label}</CardTitle></CardHeader><CardContent className="text-2xl font-bold tabular-nums">{value}</CardContent></Card></Link>)}</div>{summary.needs_attention.length ? <Card size="sm"><CardHeader><CardTitle>Leads needing attention</CardTitle></CardHeader><CardContent className="grid gap-2">{summary.needs_attention.slice(0, 4).map((lead) => <Link className="flex items-center justify-between rounded-lg border p-2 hover:bg-muted" href={`/leads/${lead.lead_id}`} key={lead.lead_id}><span>{lead.traveller_name ?? 'Traveller'} · {lead.destination ?? 'Destination TBC'}</span><span className="text-xs text-amber-600">{lead.reason}</span></Link>)}</CardContent></Card> : null}</section>;
}
