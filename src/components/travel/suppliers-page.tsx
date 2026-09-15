'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from './status-badge';
import type { Destination, Supplier } from '@/types/travel';
import { SUPPLIER_DESTINATION_OPTIONS } from '@/lib/travel/constants';

export function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [selectedDestinationIds, setSelectedDestinationIds] = useState<string[]>([]);
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
    const response = await fetch('/api/travel/suppliers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), primary_contact_name: form.get('contact'), whatsapp_phone: form.get('phone'), supplier_type: form.get('type'), preferred: form.get('preferred') === 'on', destinations: selectedDestinationIds.map((destination_id) => ({ destination_id, preferred: form.get('preferred') === 'on' })) }) });
    const body = await response.json() as { error?: string };
    if (!response.ok) { setError(body.error ?? 'Could not create supplier'); return; }
    event.currentTarget.reset(); setSelectedDestinationIds([]); await load();
  }
  async function seedDestinations() { const r = await fetch('/api/travel/destinations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'seed_defaults' }) }); if (r.ok) await load(); else setError('Only an admin can seed destinations'); }
  const choices = SUPPLIER_DESTINATION_OPTIONS.map((option) => ({ ...option, destination: destinations.find((destination) => !destination.parent_id && option.slugs.some((slug) => destination.slug === slug)) })).filter((option): option is typeof option & { destination: Destination } => Boolean(option.destination));
  const toggleDestination = (id: string) => setSelectedDestinationIds((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length < 3 ? [...current, id] : current);
  return <div className="space-y-6"><div className="flex items-start justify-between"><div><h1 className="text-2xl font-bold">Suppliers</h1><p className="mt-1 text-sm text-muted-foreground">Destination partners available for automatic RFQ matching</p></div>{choices.length < SUPPLIER_DESTINATION_OPTIONS.length ? <Button variant="outline" onClick={() => void seedDestinations()}>Add missing destinations</Button> : null}</div><Card><CardHeader><CardTitle>Add supplier</CardTitle></CardHeader><CardContent><form onSubmit={create} className="grid gap-4 md:grid-cols-6"><div className="space-y-1 md:col-span-2"><Label htmlFor="name">Supplier name</Label><Input id="name" name="name" required /></div><div className="space-y-1"><Label htmlFor="contact">Contact</Label><Input id="contact" name="contact" /></div><div className="space-y-1"><Label htmlFor="phone">WhatsApp</Label><Input id="phone" name="phone" placeholder="919876543210" /></div><div className="flex items-end gap-2 md:col-span-2"><Button type="submit">Add supplier</Button><label className="flex items-center gap-1 pb-1 text-xs"><input type="checkbox" name="preferred" /> Preferred</label><input type="hidden" name="type" value="DMC" /></div><fieldset className="md:col-span-6"><div className="mb-2 flex items-center justify-between"><legend className="text-sm font-medium">Destinations</legend><span className="text-xs text-muted-foreground">{selectedDestinationIds.length}/3 selected</span></div><div className="flex flex-wrap gap-2">{choices.map(({ label, destination }) => { const selected = selectedDestinationIds.includes(destination.id); const disabled = !selected && selectedDestinationIds.length >= 3; return <button key={destination.id} type="button" aria-pressed={selected} disabled={disabled} onClick={() => toggleDestination(destination.id)} className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${selected ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'} disabled:cursor-not-allowed disabled:opacity-40`}>{label}</button>; })}</div>{choices.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Add the default destination list to select supplier coverage.</p> : null}</fieldset></form>{error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}</CardContent></Card><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{suppliers.map((s) => <Card key={s.id}><CardHeader><div className="flex items-start justify-between"><div><CardTitle>{s.name}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{s.supplier_type.replaceAll('_', ' ')}{s.rating ? ` · ★ ${s.rating}` : ''}</p></div><StatusBadge value={s.status} /></div></CardHeader><CardContent className="space-y-2 text-sm"><p>{s.primary_contact_name ?? 'No contact name'} · {s.whatsapp_phone ?? s.phone ?? 'No phone'}</p><p className="text-muted-foreground">{(s.supplier_destinations ?? []).map((m) => m.destination?.name).filter(Boolean).join(', ') || 'No destinations mapped'}</p>{s.preferred ? <span className="text-xs font-medium text-primary">Preferred supplier</span> : null}</CardContent></Card>)}</div></div>;
}
