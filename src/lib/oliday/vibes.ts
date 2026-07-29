// ============================================================
// Vibes conversation state + routing detection.
//
// The orchestration rule (spec §1): route on the TAG, not the prose.
//   - `(vibes:<tripId>)` in the inbound → this conversation is about
//     that trip. Tag is machine-only: parsed here, stripped from
//     anything the traveller sees.
//   - the generic Vibes prefill → Vibes route with no trip.
//   - anything else → the packages agent.
// Once a conversation routes to Vibes it stays there (state persisted
// on `conversations.vibes`) until the agent explicitly hands back to
// the packages bot (a package/price ask mid-chat).
// ============================================================

export const VIBES_TAG_RE = /\(vibes:([A-Za-z0-9_-]{6,40})\)/;

/** The known Vibes entry prefills (site + ads). Deliberately narrow —
 *  a traveller saying "good vibes" mid-packages-chat must NOT reroute. */
const VIBES_GENERIC_RE =
  /tell me about vibes|how does vibes work|travelling with verified people|vibes trip/i;

export type VibeGroupType = 'LADIES_ONLY' | 'COUPLES_ONLY' | 'MIXED';

const GROUP_TYPES = new Set<string>(['LADIES_ONLY', 'COUPLES_ONLY', 'MIXED']);

export const VIBE_STAGES = [
  'EXPLAINER',
  'QUALIFY',
  'PROFILE',
  'VERIFY',
  'REQUEST',
  'WAITING_HOST',
  'HANDOFF',
] as const;
export type VibeStage = (typeof VIBE_STAGES)[number];

/** Persisted on `conversations.vibes` — presence with `active: true`
 *  is what routes the conversation to the Vibes agent. */
export interface VibesState {
  active: boolean;
  /** From the `(vibes:)` tag or resolved during the chat. */
  tripId: string | null;
  stage?: VibeStage;
  fields: {
    name?: string;
    fromCity?: string;
    travelMonth?: string;
    groupType?: VibeGroupType;
    partySize?: number;
    profileCreated?: boolean;
    phoneVerified?: boolean;
    altPhone?: string;
  };
  /** They confirmed the recap card (spec §8). Advisory — logged for
   *  the team; the bot never pauses itself or assigns anyone. */
  handoffConfirmed?: boolean;
}

/** How should this inbound route, given the sticky state?
 *  Returns the (possibly new) Vibes state to run with, or null for
 *  the packages agent. */
export function routeInbound(
  text: string,
  existing: VibesState | null
): VibesState | null {
  const tag = VIBES_TAG_RE.exec(text);
  if (tag) {
    // A tagged message (re)binds the conversation to that trip, even
    // mid-chat — the traveller tapped a trip page's WhatsApp button.
    return {
      active: true,
      tripId: tag[1],
      stage: existing?.stage,
      fields: existing?.fields ?? {},
      handoffConfirmed: existing?.handoffConfirmed,
    };
  }
  if (existing?.active) return existing;
  if (VIBES_GENERIC_RE.test(text)) {
    return { active: true, tripId: null, fields: {} };
  }
  return null;
}

/** Strip the machine tag from anything customer-facing. */
export function stripVibesTag(text: string): string {
  return text.replace(/\s*\(vibes:[A-Za-z0-9_-]{6,40}\)/g, '').trim();
}

/**
 * Merge the model's extracted fields + stage into the state — same
 * untrusted-output discipline as the packages agent's `mergeTrip`:
 * unknown keys and malformed values are dropped, filled slots are
 * never un-filled by an absent extraction.
 */
export function mergeVibes(
  current: VibesState,
  parsed: {
    vibeTripId?: unknown;
    extractedFields?: unknown;
    stage?: unknown;
    handoffConfirmed?: unknown;
  }
): VibesState {
  const next: VibesState = {
    ...current,
    fields: { ...current.fields },
  };

  if (
    typeof parsed.vibeTripId === 'string' &&
    /^[A-Za-z0-9_-]{6,40}$/.test(parsed.vibeTripId)
  ) {
    next.tripId = parsed.vibeTripId;
  }

  const e =
    parsed.extractedFields && typeof parsed.extractedFields === 'object'
      ? (parsed.extractedFields as Record<string, unknown>)
      : {};

  if (typeof e.name === 'string' && e.name.trim()) {
    next.fields.name = e.name.trim().slice(0, 60);
  }
  if (typeof e.fromCity === 'string' && e.fromCity.trim()) {
    next.fields.fromCity = e.fromCity.trim().slice(0, 60);
  }
  if (typeof e.travelMonth === 'string' && e.travelMonth.trim()) {
    next.fields.travelMonth = e.travelMonth.trim().slice(0, 40);
  }
  if (typeof e.groupType === 'string' && GROUP_TYPES.has(e.groupType)) {
    next.fields.groupType = e.groupType as VibeGroupType;
  }
  const party =
    typeof e.partySize === 'string' ? Number(e.partySize) : e.partySize;
  if (
    typeof party === 'number' &&
    Number.isFinite(party) &&
    party >= 1 &&
    party <= 20
  ) {
    next.fields.partySize = Math.floor(party);
  }
  if (e.profileCreated === true) next.fields.profileCreated = true;
  if (e.phoneVerified === true) next.fields.phoneVerified = true;
  if (typeof e.altPhone === 'string') {
    const cleaned = e.altPhone.replace(/[^\d+]/g, '');
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      next.fields.altPhone = cleaned;
    }
  }

  if (
    typeof parsed.stage === 'string' &&
    (VIBE_STAGES as readonly string[]).includes(parsed.stage)
  ) {
    next.stage = parsed.stage as VibeStage;
  }
  // Sticky once true — the recap was explicitly confirmed.
  if (parsed.handoffConfirmed === true) next.handoffConfirmed = true;

  return next;
}

/** Deterministic fallback when the LLM is down — the bot never goes
 *  silent (§ same rule as the packages agent). Safe, generic, and
 *  always answerable by tapping. */
export function vibesFallback(state: VibesState): {
  text: string;
  options: string[];
} {
  if (state.tripId) {
    return {
      text: "Give me a moment — I'm pulling up that trip's details. Meanwhile, have you created your Vibes profile yet?",
      options: ['Yes, I have', 'Not yet', 'How does it work?'],
    };
  }
  return {
    text: "Vibes is Oliday's safer way to travel with new people 🌍 — hosted trips with verified profiles that match your vibe (ladies-only, couples-only or mixed). Want me to show you the trips open right now?",
    options: ['Show open trips', 'How does it work?'],
  };
}
