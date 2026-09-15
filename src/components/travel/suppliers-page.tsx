'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from './status-badge';
import { DestinationSelect, MAX_SUPPLIER_DESTINATIONS } from './destination-select';
import type { Destination, Supplier } from '@/types/travel';
import { SUPPLIER_TYPES } from '@/types/travel';
import { DEFAULT_DESTINATIONS } from '@/lib/travel/constants';
import { slugify } from '@/lib/travel/matching';

export function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [selectedDestinationIds, setSelectedDestinationIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Owns its own error handling so the effect below contains no
  // synchronous setState call (react-hooks/set-state-in-effect).
  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([fetch('/api/travel/suppliers?all=true'), fetch('/api/travel/destinations')]);
      const sj = (await s.json()) as { suppliers?: Supplier[]; error?: string };
      const dj = (await d.json()) as { destinations?: Destination[] };
      if (!s.ok) throw new Error(sj.error ?? 'Could not load suppliers');
      setSuppliers(sj.suppliers ?? []);
      setDestinations(dj.destinations ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load suppliers');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    if (selectedDestinationIds.length === 0) {
      setError('Choose at least one destination — supplier matching is driven by destination coverage.');
      return;
    }
    setSaving(true);
    const preferred = data.get('preferred') === 'on';
    const response = await fetch('/api/travel/suppliers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: data.get('name'),
        primary_contact_name: data.get('contact'),
        whatsapp_phone: data.get('phone'),
        supplier_type: data.get('type'),
        preferred,
        destinations: selectedDestinationIds.map((destination_id) => ({ destination_id, preferred })),
      }),
    });
    const body = (await response.json()) as { error?: string };
    setSaving(false);
    if (!response.ok) {
      setError(body.error ?? 'Could not create supplier');
      return;
    }
    form.reset();
    setSelectedDestinationIds([]);
    await load();
  }

  async function seedDestinations() {
    const r = await fetch('/api/travel/destinations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'seed_defaults' }),
    });
    if (r.ok) await load();
    else setError('Only an admin can seed destinations');
  }

  // Which catalog destinations this account is missing. Seeding is
  // additive and matches on slug, so the button stays useful after the
  // first run — it tops up whatever the catalog has gained since.
  const missingDefaults = DEFAULT_DESTINATIONS.filter(
    (d) => !destinations.some((existing) => existing.slug === slugify(d.name)),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Suppliers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Destination partners available for automatic RFQ matching
          </p>
        </div>
        {missingDefaults.length > 0 ? (
          <Button
            variant="outline"
            onClick={() => void seedDestinations()}
            title={missingDefaults.map((d) => d.name).join(', ')}
          >
            {destinations.length === 0
              ? 'Add default destinations'
              : `Add ${missingDefaults.length} missing ${missingDefaults.length === 1 ? 'destination' : 'destinations'}`}
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add supplier</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="grid gap-4 md:grid-cols-6">
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="name">Supplier name</Label>
              <Input id="name" name="name" required />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="contact">Contact</Label>
              <Input id="contact" name="contact" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="phone">WhatsApp</Label>
              <Input id="phone" name="phone" placeholder="919876543210" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="type">Type</Label>
              <select
                id="type"
                name="type"
                defaultValue="DMC"
                className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
              >
                {SUPPLIER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1 md:col-span-4">
              <Label htmlFor="destinations">
                Destinations <span className="text-muted-foreground">(up to {MAX_SUPPLIER_DESTINATIONS})</span>
              </Label>
              <DestinationSelect
                destinations={destinations}
                value={selectedDestinationIds}
                onChange={setSelectedDestinationIds}
              />
            </div>

            <div className="flex items-end gap-3 md:col-span-2">
              <label className="flex items-center gap-1.5 pb-2 text-sm">
                <input type="checkbox" name="preferred" /> Preferred
              </label>
              <Button type="submit" disabled={saving} className="mb-0.5">
                {saving ? 'Adding…' : 'Add supplier'}
              </Button>
            </div>
          </form>
          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {suppliers.map((s) => (
          <Card key={s.id}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle>{s.name}</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {s.supplier_type.replaceAll('_', ' ')}
                    {s.rating ? ` · ★ ${s.rating}` : ''}
                  </p>
                </div>
                <StatusBadge value={s.status} />
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                {s.primary_contact_name ?? 'No contact name'} · {s.whatsapp_phone ?? s.phone ?? 'No phone'}
              </p>
              <p className="text-muted-foreground">
                {(s.supplier_destinations ?? [])
                  .map((m) => m.destination?.name)
                  .filter(Boolean)
                  .join(', ') || 'No destinations mapped'}
              </p>
              {s.preferred ? <span className="text-xs font-medium text-primary">Preferred supplier</span> : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
