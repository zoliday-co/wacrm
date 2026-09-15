'use client';

// ============================================================
// Destination multi-select — the supplier form's coverage picker.
//
// A supplier may serve at most three destinations (the server
// enforces the same cap in `parseSupplierInput`, so this is a
// convenience, not the guard). Selections show as removable chips
// in the trigger; the popover lists the account's destinations
// grouped by state, with sub-destinations nested under their
// parent, and filters as you type.
//
// Once three are picked the remaining rows are disabled rather
// than hidden, so it stays obvious why they can't be chosen.
// ============================================================

import { useMemo, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Destination } from '@/types/travel';

export const MAX_SUPPLIER_DESTINATIONS = 3;

export interface DestinationGroup {
  parent: Destination;
  children: Destination[];
}

/** Group active destinations under their parent, parents first, A→Z. */
export function groupDestinations(destinations: Destination[]): DestinationGroup[] {
  const active = destinations.filter((d) => d.active);
  const byId = new Map(active.map((d) => [d.id, d]));
  const groups = new Map<string, DestinationGroup>();

  for (const d of active) {
    if (d.parent_id && byId.has(d.parent_id)) continue;
    groups.set(d.id, { parent: d, children: [] });
  }
  for (const d of active) {
    if (!d.parent_id) continue;
    groups.get(d.parent_id)?.children.push(d);
  }
  return [...groups.values()]
    .sort((a, b) => a.parent.name.localeCompare(b.parent.name))
    .map((g) => ({ ...g, children: g.children.sort((a, b) => a.name.localeCompare(b.name)) }));
}

/**
 * Add or remove `id`, refusing to grow past `max`. Pure so the cap can
 * be tested without a DOM — the server enforces the same limit.
 */
export function toggleSelection(value: string[], id: string, max = MAX_SUPPLIER_DESTINATIONS): string[] {
  if (value.includes(id)) return value.filter((v) => v !== id);
  if (value.length >= max) return value;
  return [...value, id];
}

/** Filter grouped destinations by name or alias; a parent match keeps its children. */
export function filterGroups(groups: DestinationGroup[], query: string): DestinationGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  const hit = (d: Destination) =>
    d.name.toLowerCase().includes(needle) || (d.aliases ?? []).some((a) => a.toLowerCase().includes(needle));
  return groups
    .map((g) => (hit(g.parent) ? g : { ...g, children: g.children.filter(hit) }))
    .filter((g) => hit(g.parent) || g.children.length > 0);
}

export function DestinationSelect({
  destinations,
  value,
  onChange,
  max = MAX_SUPPLIER_DESTINATIONS,
  disabled,
}: {
  destinations: Destination[];
  value: string[];
  onChange: (next: string[]) => void;
  max?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const groups = useMemo(() => groupDestinations(destinations), [destinations]);
  const byId = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations]);
  const selected = value.map((id) => byId.get(id)).filter((d): d is Destination => Boolean(d));
  const atMax = value.length >= max;

  const visible = useMemo(() => filterGroups(groups, query), [groups, query]);

  function toggle(id: string) {
    onChange(toggleSelection(value, id, max));
  }

  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          disabled={disabled}
          render={
            <button
              type="button"
              className={cn(
                'flex min-h-9 w-full items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5 text-left text-sm',
                'transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            />
          }
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {selected.length === 0 ? (
              <span className="text-muted-foreground">Select destinations</span>
            ) : (
              selected.map((d) => (
                <span
                  key={d.id}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2 pr-1 text-xs font-medium text-primary"
                >
                  {d.name}
                  {/* A nested <button> is invalid inside the trigger button,
                      so the chip's remove affordance is a span with a click
                      handler that stops the popover from opening. */}
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Remove ${d.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onChange(value.filter((v) => v !== d.id));
                    }}
                    className="rounded-full p-0.5 hover:bg-primary/20"
                  >
                    <X className="size-3" />
                  </span>
                </span>
              ))
            )}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </PopoverTrigger>

        <PopoverContent align="start" className="w-80 p-0">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search destinations"
                aria-label="Search destinations"
                className="h-8 pl-7 text-sm"
              />
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto p-1">
            {visible.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                {destinations.length === 0 ? 'No destinations yet — add the default list first.' : 'No match.'}
              </p>
            ) : (
              visible.map((group) => (
                <div key={group.parent.id} className="mb-1">
                  <Row
                    destination={group.parent}
                    checked={value.includes(group.parent.id)}
                    disabled={!value.includes(group.parent.id) && atMax}
                    onToggle={toggle}
                  />
                  {group.children.map((child) => (
                    <Row
                      key={child.id}
                      destination={child}
                      nested
                      checked={value.includes(child.id)}
                      disabled={!value.includes(child.id) && atMax}
                      onToggle={toggle}
                    />
                  ))}
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
            <span>
              {value.length} of {max} selected
            </span>
            {value.length > 0 ? (
              <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onChange([])}>
                Clear
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      <p className="text-xs text-muted-foreground">
        {atMax ? `Maximum ${max} destinations — remove one to change coverage.` : `Choose up to ${max} destinations this supplier covers.`}
      </p>
    </div>
  );
}

function Row({
  destination,
  checked,
  disabled,
  nested,
  onToggle,
}: {
  destination: Destination;
  checked: boolean;
  disabled: boolean;
  nested?: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      disabled={disabled}
      onClick={() => onToggle(destination.id)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        checked && 'bg-primary/10',
        nested && 'pl-6',
      )}
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
        )}
      >
        {checked ? <Check className="size-3" /> : null}
      </span>
      <span className={cn('truncate', nested && 'text-muted-foreground')}>{destination.name}</span>
    </button>
  );
}
