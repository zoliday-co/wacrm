'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from './status-badge';
import type { Destination, Supplier } from '@/types/travel';

export function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [s, d] = await Promise.all([fetch('/api/travel/suppliers?all=true'), fetch('/api/travel/destinations')]);
    const sj = await s.json() as { suppliers?: Supplier[]; error?: string };
    const dj = await d.json() as { destinations?: Destination[] };
    if (!s.ok) throw new Error(sj.error ?? 'Could not load suppliers');
    setSuppliers(sj.suppliers ?? []); setDestinations(dj.destinations ?? []);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [load]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    const form = new FormData(event.currentTarget);
    const destinationId = String(form.get('destination_id') ?? '');
    const response = await fetch('/api/travel/suppliers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), primary_contact_name: form.get('contact'), whatsapp_phone: form.get('phone'), supplier_type: form.get('type'), preferred: form.get('preferred') === 'on', destinations: destinationId ? [{ destination_id: destinationId, preferred: form.get('preferred') === 'on' }] : [] }) });
    const body = await response.json() as { error?: string };
    if (!response.ok) { setError(body.error ?? 'Could not create supplier'); return; }
    event.currentTarget.reset(); await load();
  }
  async function seedDestinations() { const r = await fetch('/api/travel/destinations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'seed_defaults' }) }); if (r.ok) await load(); else setError('Only an admin can seed destinations'); }
  return <div className="space-y-6"><div className="flex items-start justify-between"><div><h1 className="text-2xl font-bold">Suppliers</h1><p className="mt-1 text-sm text-muted-foreground">Destination partners available for automatic RFQ matching</p></div>{destinations.length === 0 ? <Button variant="outline" onClick={() => void seedDestinations()}>Add default destinations</Button> : null}</div><Card><CardHeader><CardTitle>Add supplier</CardTitle></CardHeader><CardContent><form onSubmit={create} className="grid gap-3 md:grid-cols-6"><div className="space-y-1 md:col-span-2"><Label htmlFor="name">Supplier name</Label><Input id="name" name="name" required /></div><div className="space-y-1"><Label htmlFor="contact">Contact</Label><Input id="contact" name="contact" /></div><div className="space-y-1"><Label htmlFor="phone">WhatsApp</Label><Input id="phone" name="phone" placeholder="919876543210" /></div><div className="space-y-1"><Label htmlFor="destination_id">Destination</Label><select id="destination_id" name="destination_id" className="h-8 w-full rounded-lg border bg-background px-2 text-sm"><option value="">Any / later</option>{destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div><div className="flex items-end gap-2"><Button type="submit">Add supplier</Button><label className="flex items-center gap-1 pb-1 text-xs"><input type="checkbox" name="preferred" /> Preferred</label><input type="hidden" name="type" value="DMC" /></div></form>{error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}</CardContent></Card><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{suppliers.map((s) => <Card key={s.id}><CardHeader><div className="flex items-start justify-between"><div><CardTitle>{s.name}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{s.supplier_type.replaceAll('_', ' ')}{s.rating ? ` · ★ ${s.rating}` : ''}</p></div><StatusBadge value={s.status} /></div></CardHeader><CardContent className="space-y-2 text-sm"><p>{s.primary_contact_name ?? 'No contact name'} · {s.whatsapp_phone ?? s.phone ?? 'No phone'}</p><p className="text-muted-foreground">{(s.supplier_destinations ?? []).map((m) => m.destination?.name).filter(Boolean).join(', ') || 'No destinations mapped'}</p>{s.preferred ? <span className="text-xs font-medium text-primary">Preferred supplier</span> : null}</CardContent></Card>)}</div></div>;
}
