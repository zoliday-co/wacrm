// ============================================================
// Supplier RFQ WhatsApp message — pure rendering.
//
// The supplier receives ONLY what they need to quote. This module
// takes the requirement fields explicitly (never the lead row) so
// traveller PII — name, phone, conversation, campaign — cannot
// leak into the text by accident. The test suite asserts this.
// ============================================================

import {
  childAgesLabel,
  datesLabel,
  destinationsLabel,
  durationLabel,
  fmtDateTime,
  paxLabel,
  roomsLabel,
  type TripSummaryFields,
} from './format';
import { hotelCategoryLabel } from './constants';

export interface RfqMessageInput {
  supplierName: string;
  requirement: TripSummaryFields;
  quoteUrl: string;
  deadlineIso: string | null;
  /** Requirement version number (>1 → "Revised requirement"). */
  version?: number;
  brand?: string;
}

/** Positional body parameters for an approved WhatsApp template
 *  (`{{1}}` supplier name, `{{2}}` trip summary, `{{3}}` link, `{{4}}` deadline). */
export function rfqTemplateParams(input: RfqMessageInput): string[] {
  const r = input.requirement;
  const summary = [
    destinationsLabel(r),
    durationLabel(r),
    paxLabel(r),
    datesLabel(r),
  ]
    .filter(Boolean)
    .join(', ');
  return [
    input.supplierName,
    summary,
    input.quoteUrl,
    input.deadlineIso ? fmtDateTime(input.deadlineIso) : 'as soon as possible',
  ];
}

export function renderRfqMessage(input: RfqMessageInput): string {
  const r = input.requirement;
  const brand = input.brand ?? 'Oliday';
  const lines: string[] = [];

  lines.push(`Hi ${input.supplierName},`);
  lines.push('');
  lines.push(
    input.version && input.version > 1
      ? `Revised ${brand} travel requirement (v${input.version}):`
      : `New ${brand} travel requirement:`
  );
  lines.push('');
  lines.push(`Destination: ${destinationsLabel(r)}`);
  if (r.departure_city) lines.push(`Departure city: ${r.departure_city}`);
  lines.push(`Travel: ${datesLabel(r)}`);
  const dur = durationLabel(r);
  if (dur) lines.push(`Duration: ${dur.replace('N/', ' Nights / ').replace('D', ' Days')}`);
  lines.push(`Travellers: ${paxLabel(r)}`);
  const ages = childAgesLabel(r);
  if (ages) lines.push(ages);
  const rooms = roomsLabel(r);
  if (rooms) lines.push(`Rooms: ${rooms}`);
  lines.push(`Stay: ${hotelCategoryLabel(r.hotel_category)}`);
  if (r.meal_plan) lines.push(`Meal Plan: ${r.meal_plan}`);
  if (r.vehicle_type) lines.push(`Vehicle: ${r.vehicle_type}`);
  if (r.pickup_location) lines.push(`Pickup: ${r.pickup_location}`);
  if (r.drop_location) lines.push(`Drop: ${r.drop_location}`);
  if (r.activities && r.activities.length) lines.push(`Sightseeing: ${r.activities.join(', ')}`);
  if (r.special_requests) lines.push(`Special requirements: ${r.special_requests}`);
  lines.push('');
  lines.push('Please submit your best B2B quote using the link below:');
  lines.push('');
  lines.push(input.quoteUrl);
  lines.push('');
  if (input.deadlineIso) {
    lines.push('Quote required by:');
    lines.push(fmtDateTime(input.deadlineIso));
    lines.push('');
  }
  lines.push('Thank you,');
  lines.push(brand);
  return lines.join('\n');
}

export function renderRfqReminder(input: RfqMessageInput): string {
  const r = input.requirement;
  const brand = input.brand ?? 'Oliday';
  const deadline = input.deadlineIso ? ` by ${fmtDateTime(input.deadlineIso)}` : '';
  return [
    `Hi ${input.supplierName}, a gentle reminder from ${brand}.`,
    '',
    `We're still waiting for your quote for ${destinationsLabel(r)} (${durationLabel(r) || 'dates flexible'}, ${paxLabel(r)}).`,
    '',
    `Please submit it${deadline} using this link:`,
    input.quoteUrl,
    '',
    'Thank you!',
  ].join('\n');
}

/** Traveller "quotes ready" message (uses the traveller's first name only). */
export function renderQuotesReadyMessage(input: {
  travellerName: string | null;
  destination: string | null;
  callbackUrl: string;
  brand?: string;
}): string {
  const first = (input.travellerName ?? '').trim().split(/\s+/)[0] || 'there';
  const dest = input.destination ? `your ${input.destination} trip` : 'your trip';
  return [
    `Hi ${first} 👋`,
    '',
    `We have received options for ${dest}.`,
    '',
    'Our travel expert can now walk you through the best options and customise the package if required.',
    '',
    'Please choose a convenient time for a quick call:',
    '',
    input.callbackUrl,
  ].join('\n');
}

export function quotesReadyTemplateParams(input: {
  travellerName: string | null;
  destination: string | null;
  callbackUrl: string;
}): string[] {
  const first = (input.travellerName ?? '').trim().split(/\s+/)[0] || 'there';
  return [first, input.destination ?? 'your trip', input.callbackUrl];
}

/** Traveller quote share message. */
export function renderTravellerQuoteMessage(input: {
  travellerName: string | null;
  destination: string | null;
  total: string;
  validUntil: string | null;
  quoteUrl: string;
  version: number;
  brand?: string;
}): string {
  const first = (input.travellerName ?? '').trim().split(/\s+/)[0] || 'there';
  const brand = input.brand ?? 'Oliday';
  return [
    `Hi ${first} 👋`,
    '',
    `Your ${brand} package${input.version > 1 ? ` (updated, v${input.version})` : ''} for ${input.destination ?? 'your trip'} is ready.`,
    '',
    `Total: ${input.total}${input.validUntil ? ` (valid until ${input.validUntil})` : ''}`,
    '',
    'View the full itinerary, inclusions and price here:',
    input.quoteUrl,
    '',
    'You can accept the package, request a change, or ask to talk to your travel expert from that page.',
  ].join('\n');
}
