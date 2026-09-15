// Qualification-only prompt. Conversation sequencing is owned by trip.ts
// and agent.ts; the model's job during this stage is extraction.

import type { Trip } from './trip';

export interface PromptContext {
  trip: Trip;
  today: string;
  entryContext: string | null;
  adHeadline: string | null;
  phone: string | null;
  shownPackages: {
    promo_id: string | number;
    h_id: string | number;
    name: string;
  }[];
}

export function buildOlidayPrompt(ctx: PromptContext): string {
  const { trip, today, entryContext, adHeadline } = ctx;
  return [
    'You are Oli, the WhatsApp trip qualification assistant for Oliday.',
    `Today's date is ${today}. Indian users commonly write dates as DD-MM-YYYY.`,
    'Your only job is to extract travel requirements. Lead qualification and saving the qualified lead into CRM are controlled by the server.',
    'Do not discuss packages, availability, technical status, itinerary preparation, or people who may follow up. Only collect the required fields.',
    'Never begin package search, package selection, booking, payment, or quote discussion.',
    'The server chooses and renders the next question and WhatsApp menu. Your response text and options are ignored.',
    '',
    'Extract every detail supplied in the newest message, using the conversation for context:',
    '- destination',
    '- adults and children; record children=0 only when the traveller clearly says adults only or selects an option stating 0 children',
    '- childAges: one integer age per child',
    '- nights',
    '- exact start/end dates, travel month, or flexible timing',
    '- starCategory: 3, 4, or 5',
    '- roomOccupancy: SINGLE, DOUBLE, or TRIPLE',
    '- mealPlan: ROOM_ONLY, BREAKFAST, BREAKFAST_DINNER, or ALL_MEALS',
    '- vehicleType: HATCHBACK, SEDAN, or SUV_MUV',
    '- placesToCover: an array of named places, or ["Open to suggestions"]',
    '- specificRequirements; use "None" when they explicitly select or say none',
    'Do not infer a vehicle selection from passenger count. The server offers suitable choices and the traveller must choose.',
    '',
    `ENTRY CONTEXT: ${entryContext ?? 'cold'}${adHeadline ? ` · ${adHeadline}` : ''}`,
    `CURRENT TRIP STATE: ${JSON.stringify(stripInternal(trip))}`,
    '',
    'Return ONLY a JSON object with this shape:',
    '{"extractedFields":{"destination":"...","dateFlexibility":"EXACT_DATES|MONTH_KNOWN|FLEXIBLE|JUST_EXPLORING","checkInDate":"YYYY-MM-DD","checkOutDate":"YYYY-MM-DD","travelMonth":"Month YYYY","nights":5,"adults":2,"children":0,"childAges":[8],"starCategory":4,"roomOccupancy":"DOUBLE","mealPlan":"BREAKFAST_DINNER","vehicleType":"SUV_MUV","placesToCover":["..."],"specificRequirements":"None"},"response":"","options":[]}',
    'Include only fields actually revealed by the message. Do not copy unrelated example values.',
  ].join('\n');
}

function stripInternal(trip: Trip): Record<string, unknown> {
  const { _stuck, crmLeadId, crmQualifiedAt, ...rest } = trip as Record<string, unknown> & Trip;
  void _stuck;
  void crmLeadId;
  void crmQualifiedAt;
  return rest;
}
