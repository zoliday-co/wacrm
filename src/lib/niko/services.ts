// ============================================================
// Niko's service catalogue.
//
// Each service names the handful of facts a human needs before the
// request can actually be fulfilled. The agent's whole job in the MVP
// is to work out WHICH service the user wants and collect THOSE facts —
// fulfilment is manual, so nothing here talks to a booking backend.
//
// The cadences in the comments are why the assistant is one thread and
// not six apps: no single service is frequent enough to earn a place on
// the home screen, but together they add up to a weekly habit.
// ============================================================

export type NikoService =
  | 'airport_cab'
  | 'restaurant'
  | 'movie'
  | 'gifting'
  | 'job_search'
  | 'medicine';

export interface ServiceSpec {
  id: NikoService;
  /** How Niko names it to the user. */
  label: string;
  /** Shown as a quick-reply chip — kept under WhatsApp's 20-char button cap. */
  chip: string;
  /** Ordered: Niko asks for the first one still missing. */
  required: { key: string; ask: string }[];
}

export const SERVICES: ServiceSpec[] = [
  {
    // A few times a month for frequent travellers, rarer for everyone else.
    id: 'airport_cab',
    label: 'airport cab',
    chip: 'Airport cab',
    required: [
      { key: 'pickup', ask: 'Where should the cab pick you up?' },
      { key: 'drop', ask: 'Which airport (or drop point) are you heading to?' },
      { key: 'when', ask: 'What date and pickup time?' },
      { key: 'passengers', ask: 'How many passengers, and any bags to plan for?' },
    ],
  },
  {
    // Weekly-ish for the best users — the habit-forming one.
    id: 'restaurant',
    label: 'restaurant booking',
    chip: 'Restaurant',
    required: [
      { key: 'city', ask: 'Which city or area are you looking in?' },
      { key: 'preference', ask: 'Any particular restaurant or cuisine in mind?' },
      { key: 'when', ask: 'What date and time?' },
      { key: 'partySize', ask: 'How many people?' },
    ],
  },
  {
    // One to two times a month.
    id: 'movie',
    label: 'movie tickets',
    chip: 'Movie tickets',
    required: [
      { key: 'city', ask: 'Which city, and a preferred cinema if you have one?' },
      { key: 'movie', ask: 'Which movie (or shall I suggest what is running)?' },
      { key: 'when', ask: 'What date and show time works?' },
      { key: 'seats', ask: 'How many seats?' },
    ],
  },
  {
    // A few times a year, but high margin per transaction.
    id: 'gifting',
    label: 'gifting',
    chip: 'Gifting',
    required: [
      { key: 'occasion', ask: 'What is the occasion?' },
      { key: 'recipient', ask: 'Who is it for — and what are they into?' },
      { key: 'budget', ask: 'Rough budget you have in mind?' },
      { key: 'delivery', ask: 'Where and by when should it reach them?' },
    ],
  },
  {
    // Intense for two to three months, then the user leaves because
    // you succeeded. Worth serving well anyway: they refer.
    id: 'job_search',
    label: 'job search',
    chip: 'Job search',
    required: [
      { key: 'role', ask: 'What kind of role are you looking for?' },
      { key: 'location', ask: 'Which cities, or is remote fine?' },
      { key: 'experience', ask: 'How many years of experience, and in what?' },
      { key: 'availability', ask: 'When could you start — any notice period?' },
    ],
  },
  {
    id: 'medicine',
    label: 'medicine order',
    chip: 'Medicines',
    required: [
      { key: 'items', ask: 'Which medicines do you need? A photo of the prescription works too.' },
      { key: 'address', ask: 'Where should they be delivered?' },
      { key: 'urgency', ask: 'How soon do you need them?' },
    ],
  },
];

export function serviceSpec(id: NikoService | null): ServiceSpec | null {
  if (!id) return null;
  return SERVICES.find((s) => s.id === id) ?? null;
}

export function isNikoService(value: unknown): value is NikoService {
  return (
    typeof value === 'string' && SERVICES.some((s) => s.id === value)
  );
}

/** The next unanswered required field for a service, or null when the
 *  request has everything a human needs to act on it. */
export function nextMissing(
  service: NikoService,
  fields: Record<string, string>
): { key: string; ask: string } | null {
  const spec = serviceSpec(service);
  if (!spec) return null;
  return spec.required.find((f) => !fields[f.key]?.trim()) ?? null;
}
