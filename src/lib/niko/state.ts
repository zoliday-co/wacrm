// ============================================================
// Niko's per-conversation state — the mirror of `conversations.trip`
// for the packages agent and `conversations.vibes` for Vibes.
//
// Deliberately small: which service the user is asking about, the
// facts collected for it so far, and where the request has got to.
// The model proposes updates as JSON; `mergeNiko` is what actually
// decides what sticks, so a hallucinated field can never overwrite a
// value the user gave us.
// ============================================================

import { isNikoService, nextMissing, serviceSpec, type NikoService } from './services';

export type NikoStage =
  /** No service picked yet — Niko is working out what they want. */
  | 'discover'
  /** Service known, still gathering the required facts. */
  | 'collecting'
  /** Everything collected; Niko has recapped and is awaiting a yes. */
  | 'confirming'
  /** Confirmed — a human fulfils from here. */
  | 'submitted';

export interface NikoState {
  service: NikoService | null;
  fields: Record<string, string>;
  stage: NikoStage;
  /**
   * The memory layer, in its smallest useful form: durable facts worth
   * carrying between requests (home address, usual airport, the cuisine
   * they always pick). Niko is meant to get faster and more personal
   * over time, so these are asked once and re-used, never re-asked.
   */
  prefs: Record<string, string>;
  /** Recent completed requests, newest first — what makes "same as last
   *  time" and the reorder flow possible. Capped; this rides in a JSONB
   *  column on every turn. */
  history: NikoPastRequest[];
}

export interface NikoPastRequest {
  service: NikoService;
  /** One-line human summary, the way Niko would read it back. */
  summary: string;
  /** ISO date — the model is told today's date and compares. */
  at: string;
}

/** Past requests kept per conversation. Enough for "the usual" without
 *  bloating the row or the prompt. */
export const HISTORY_LIMIT = 10;

export function emptyNiko(): NikoState {
  return { service: null, fields: {}, stage: 'discover', prefs: {}, history: [] };
}

/** Read state off the conversation row, tolerating anything. */
export function parseNiko(raw: unknown): NikoState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyNiko();
  const r = raw as Record<string, unknown>;
  const fields: Record<string, string> = {};
  if (r.fields && typeof r.fields === 'object' && !Array.isArray(r.fields)) {
    for (const [k, v] of Object.entries(r.fields as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) fields[k] = v.trim();
    }
  }
  const prefs: Record<string, string> = {};
  if (r.prefs && typeof r.prefs === 'object' && !Array.isArray(r.prefs)) {
    for (const [k, v] of Object.entries(r.prefs as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) prefs[k] = v.trim();
    }
  }
  const history: NikoPastRequest[] = Array.isArray(r.history)
    ? (r.history as unknown[])
        .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
        .filter((h) => isNikoService(h.service) && typeof h.summary === 'string')
        .map((h) => ({
          service: h.service as NikoService,
          summary: String(h.summary),
          at: typeof h.at === 'string' ? h.at : '',
        }))
        .slice(0, HISTORY_LIMIT)
    : [];
  return {
    service: isNikoService(r.service) ? r.service : null,
    fields,
    stage: isStage(r.stage) ? r.stage : 'discover',
    prefs,
    history,
  };
}

function isStage(v: unknown): v is NikoStage {
  return v === 'discover' || v === 'collecting' || v === 'confirming' || v === 'submitted';
}

/**
 * Fold the model's proposal into the state.
 *
 * Rules that matter:
 *   - A field already answered is NOT overwritten by a later turn. The
 *     model re-states old fields constantly, and a re-statement drifts
 *     ("6pm" becoming "evening"); first answer wins until the user
 *     themselves changes it, which arrives as a service switch.
 *   - Switching service clears the collected fields. Half a restaurant
 *     booking is not a head start on a cab.
 *   - Stage is derived, never taken on trust: a model that claims
 *     'submitted' with three fields missing does not get to skip them.
 */
export function mergeNiko(
  prev: NikoState,
  proposal: {
    service?: unknown;
    extractedFields?: unknown;
    requestConfirmed?: unknown;
    /** Durable facts the model noticed ("lives in Indiranagar", "always
     *  aisle seat"). Unlike request fields these DO get updated — a
     *  preference that changed is the whole point of remembering it. */
    preferences?: unknown;
  },
  today = new Date().toISOString().slice(0, 10)
): NikoState {
  const proposed = isNikoService(proposal.service) ? proposal.service : null;
  const switched = proposed !== null && prev.service !== null && proposed !== prev.service;

  const service = proposed ?? prev.service;
  const fields = switched ? {} : { ...prev.fields };

  if (
    proposal.extractedFields &&
    typeof proposal.extractedFields === 'object' &&
    !Array.isArray(proposal.extractedFields)
  ) {
    const spec = serviceSpec(service);
    const allowed = new Set((spec?.required ?? []).map((f) => f.key));
    for (const [k, v] of Object.entries(
      proposal.extractedFields as Record<string, unknown>
    )) {
      // Only keys this service actually asks for, and only when empty.
      if (!allowed.has(k)) continue;
      if (typeof v !== 'string' || !v.trim()) continue;
      if (fields[k]?.trim()) continue;
      fields[k] = v.trim();
    }
  }

  const prefs = { ...prev.prefs };
  if (
    proposal.preferences &&
    typeof proposal.preferences === 'object' &&
    !Array.isArray(proposal.preferences)
  ) {
    for (const [k, v] of Object.entries(
      proposal.preferences as Record<string, unknown>
    )) {
      if (typeof v === 'string' && v.trim()) prefs[k] = v.trim();
    }
  }

  const stage = deriveStage(service, fields, proposal.requestConfirmed === true);

  // A request that just reached 'submitted' becomes memory. Guarded on
  // the TRANSITION, so a confirmed request re-confirmed on the next
  // turn does not stack duplicates in the history.
  let history = prev.history;
  if (stage === 'submitted' && prev.stage !== 'submitted' && service) {
    history = [
      { service, summary: summarise(service, fields), at: today },
      ...prev.history,
    ].slice(0, HISTORY_LIMIT);
  }

  return { service, fields, stage, prefs, history };
}

/** Flatten a completed request into the one line Niko would read back. */
function summarise(service: NikoService, fields: Record<string, string>): string {
  const spec = serviceSpec(service);
  if (!spec) return '';
  const parts = spec.required
    .map((f) => fields[f.key])
    .filter((v): v is string => !!v && v.trim() !== '');
  return `${spec.label}: ${parts.join(', ')}`;
}

function deriveStage(
  service: NikoService | null,
  fields: Record<string, string>,
  confirmed: boolean
): NikoStage {
  if (!service) return 'discover';
  if (nextMissing(service, fields)) return 'collecting';
  return confirmed ? 'submitted' : 'confirming';
}

/**
 * What Niko says when the model is unreachable. Never a dead end: it
 * always advances the same conversation the agent would have.
 */
export function nikoFallback(state: NikoState): { text: string; options: string[] } {
  if (!state.service) {
    return {
      text: "Hi! I'm Niko. I can sort out airport cabs, restaurant tables, movie tickets, gifts, medicines, or a job search. What do you need?",
      options: ['Airport cab', 'Restaurant', 'Movie tickets', 'Gifting', 'Medicines', 'Job search'],
    };
  }
  const missing = nextMissing(state.service, state.fields);
  if (missing) return { text: missing.ask, options: [] };
  return {
    text: `${recap(state)}\n\nShall I get this going?`,
    options: ['Yes, go ahead', 'Change something'],
  };
}

/** The recap Niko reads back before a human picks the request up. */
export function recap(state: NikoState): string {
  const spec = serviceSpec(state.service);
  if (!spec) return '';
  const lines = spec.required
    .filter((f) => state.fields[f.key])
    .map((f) => `- ${state.fields[f.key]}`);
  return [`Here's your ${spec.label}:`, ...lines].join('\n');
}
