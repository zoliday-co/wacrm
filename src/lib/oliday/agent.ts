// ============================================================
// The Oliday agent turn — invoked from `dispatchInboundToAiReply`
// when the bot is enabled and the account runs provider='gemini'.
//
// The qualification agent owns:
//   - trip-slot state on `conversations.trip` (source of truth)
//   - Gemini extraction of free-text answers
//   - interactive quick replies (buttons ≤3, list 4–10)
//   - deterministic fallback on LLM failure (the bot never goes
//     silent on an inbound)
//   - idempotent creation of a qualified CRM lead and its first RFQ
//
// Contract with the caller: NEVER throws — a failing turn must not
// affect the webhook's 200 to Meta.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiConfig, ChatMessage } from '@/lib/ai/types';
import { AiError } from '@/lib/ai/types';
import { aiRequestTimeoutMs } from '@/lib/ai/defaults';
import { logAiUsage } from '@/lib/ai/usage';
import {
  generateGeminiToolLoop,
  type GeminiTool,
} from '@/lib/ai/providers/gemini';
import {
  buildContext,
  claimSlot,
  parseAgentJson,
  sendPlain,
  sendWithOptions,
  sleep,
  type OlidayTurnArgs,
} from './shared';
import { searchPackages } from './search';
import { getPackage } from './package';
import { buildOlidayPrompt } from './prompt';
import { parseDealLink, tripFromDealLink } from './entry';
import {
  mergeTrip,
  fallbackQuestion,
  deterministicExtract,
  isQualifiedTrip,
  qualificationRecap,
  type Trip,
} from './trip';
import { syncQualifiedTripToCrm } from './qualified-lead';

// Re-exported so callers (webhook dispatch, tests) keep one import
// point for the agent surface.
export type { OlidayInbound, OlidayTurnArgs } from './shared';
export { parseAgentJson } from './shared';

/** Rapid-fire messages ("Kashmir" / "5 nights" / "2 of us" in three
 *  bubbles) collapse into one turn: wait for this much silence, then
 *  only the invocation holding the newest message proceeds. */
const DEBOUNCE_MS = 2500;

const MEDIA_ACK =
  "Thanks for sharing! I can't read attachments here yet. Please send the trip details in text so I can capture them accurately.";

const QUALIFIED_READY_TO_SAVE =
  'Thank you — I have all your trip requirements. Please confirm once to finish adding the lead.';

interface AgentJson {
  extractedFields?: unknown;
  response?: string;
  options?: unknown;
  /** False when the message is unrelated to trip planning. */
  isRelevant?: boolean;
}

export async function runOlidayTurn(args: OlidayTurnArgs): Promise<void> {
  const { db, accountId, conversationId, contactId, config, inbound } = args;

  try {
    // ---- Load bot state ----------------------------------------
    const { data: conv, error: convError } = await db
      .from('conversations')
      .select('trip, shown_packages, entry_context')
      .eq('id', conversationId)
      .maybeSingle();
    if (convError) {
      console.error('[oliday] conversation state load failed:', convError.message);
    }
    let trip: Trip = (conv?.trip as Trip) ?? {};
    const shownPackages = Array.isArray(conv?.shown_packages)
      ? (conv!.shown_packages as {
          promo_id: string | number;
          h_id: string | number;
          name: string;
        }[])
      : [];

    // ---- Non-text inbound: acknowledge, stay on the case -------
    // Deliberately NO handoff (operator preference: the bot carries
    // the conversation). The attachment sits in the inbox for any
    // human to glance at; the bot keeps working the text thread.
    if (
      inbound.contentType !== 'text' &&
      inbound.contentType !== 'interactive'
    ) {
      if (!(await claimSlot(db, conversationId))) return;
      await sendPlain(args, MEDIA_ACK);
      return;
    }

    // ---- Debounce ----------------------------------------------
    // Only for typed text; a button tap is a single deliberate act.
    if (inbound.contentType === 'text') {
      await sleep(DEBOUNCE_MS);
      const { data: newest } = await db
        .from('messages')
        .select('message_id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (newest && newest.message_id !== inbound.wamid) {
        // A newer message arrived while we waited — its own webhook
        // invocation sees the full batch; this one stands down.
        return;
      }
    }

    // ---- First-turn prefill from a deal deep link --------------
    // The deal CTA embeds title/nights/destination; parsing it here
    // means the bot never re-asks what the link already said, even
    // if the model misses the extraction.
    if (!trip.destination) {
      const deal = parseDealLink(inbound.text);
      if (deal) trip = { ...trip, ...tripFromDealLink(deal) };
    }

    // ---- Context: text AND interactive turns -------------------
    // The generic builder skips interactive rows, but button taps
    // ARE the traveller's answers here — a slot-filling bot that
    // can't see them re-asks everything.
    const messages = await buildContext(db, conversationId);
    if (messages.length === 0) return;

    // ---- Ad attribution + the traveller's number ---------------
    // The phone feeds the Stage 3 recap card (shown back, never asked).
    const { data: contactRow } = await db
      .from('contacts')
      .select('referral, phone, name')
      .eq('id', contactId)
      .maybeSingle();
    const adHeadline =
      contactRow?.referral &&
      typeof (contactRow.referral as Record<string, unknown>).headline ===
        'string'
        ? ((contactRow.referral as Record<string, unknown>).headline as string)
        : null;
    const phone =
      typeof contactRow?.phone === 'string' && contactRow.phone.trim()
        ? contactRow.phone.trim()
        : null;

    // ---- The LLM turn (one retry, then deterministic fallback) --
    let result: {
      parsed: AgentJson;
      usage: Parameters<typeof logAiUsage>[1]['usage'];
      searchShown: {
        promo_id: string | number;
        h_id: string | number;
        name: string;
      }[];
    } | null = null;

    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        result = await generateTurn({
          config,
          trip,
          entryContext: (conv?.entry_context as string | null) ?? null,
          adHeadline,
          phone,
          shownPackages,
          messages,
        });
      } catch (err) {
        console.error(
          `[oliday] generation attempt ${attempt + 1} failed:`,
          err instanceof AiError ? `${err.code}: ${err.message}` : err
        );
      }
    }

    if (!result) {
      // LLM down (twice per this turn) — never go silent (§11).
      // First consume the traveller's answer deterministically (their
      // typed text or the fallback question's own button label), so
      // the loop PROGRESSES through the slots instead of re-asking
      // the same one.
      trip = mergeTrip(trip, deterministicExtract(inbound.text));
      trip = await maybeSyncQualifiedTrip({
        db,
        accountId,
        conversationId,
        contactName: typeof contactRow?.name === 'string' ? contactRow.name : null,
        phone,
        referral:
          contactRow?.referral && typeof contactRow.referral === 'object'
            ? (contactRow.referral as Record<string, unknown>)
            : null,
        existingLeadId: null,
        trip,
      });
      await persistTrip(db, conversationId, trip, null);
      const q = fallbackQuestion(trip);
      if (!(await claimSlot(db, conversationId))) return;
      await sendWithOptions(args, q.text, q.options);
      return;
    }

    // ---- Merge extraction + stage progress ---------------------
    // Menu labels and common short answers have a deterministic parser.
    // Merge it on successful LLM turns too, so a harmless model miss can
    // never discard a value the server itself knows how to interpret.
    trip = mergeTrip(trip, deterministicExtract(inbound.text));
    trip = mergeTrip(trip, result.parsed.extractedFields);

    // Qualification and CRM ingestion are driven by validated state,
    // never by an LLM flag. The deterministic idempotency key makes a
    // repeated Meta delivery safe.
    trip = await maybeSyncQualifiedTrip({
      db,
      accountId,
      conversationId,
      contactName: typeof contactRow?.name === 'string' ? contactRow.name : null,
      phone,
      referral:
        contactRow?.referral && typeof contactRow.referral === 'object'
          ? (contactRow.referral as Record<string, unknown>)
          : null,
      existingLeadId: null,
      trip,
    });

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    });

    await persistTrip(
      db,
      conversationId,
      trip,
      result.searchShown.length > 0 ? result.searchShown : null
    );

    // During qualification the server owns the next step. This keeps
    // the bot from skipping fields, asking questions out of order, or
    // attempting catalog search while the lead brief is incomplete.
    if (!isQualifiedTrip(trip)) {
      const q = fallbackQuestion(trip);
      if (!(await claimSlot(db, conversationId))) return;
      await sendWithOptions(args, q.text, q.options);
      return;
    }

    // There is no handoff stage. Completion means the lead exists in
    // CRM; acknowledge that result and end the qualification flow.
    if (!(await claimSlot(db, conversationId))) return;
    await sendWithOptions(
      args,
      trip.crmLeadId ? qualificationRecap(trip) : QUALIFIED_READY_TO_SAVE,
      trip.crmLeadId ? [] : ['Confirm']
    );
    return;
  } catch (err) {
    console.error('[oliday] turn failed:', err);
  }
}

// ------------------------------------------------------------
// Generation
// ------------------------------------------------------------

async function generateTurn(input: {
  config: AiConfig;
  trip: Trip;
  entryContext: string | null;
  adHeadline: string | null;
  phone: string | null;
  shownPackages: {
    promo_id: string | number;
    h_id: string | number;
    name: string;
  }[];
  messages: ChatMessage[];
}): Promise<{
  parsed: AgentJson;
  usage: Parameters<typeof logAiUsage>[1]['usage'];
  searchShown: {
    promo_id: string | number;
    h_id: string | number;
    name: string;
  }[];
}> {
  const {
    config,
    trip,
    entryContext,
    adHeadline,
    phone,
    shownPackages,
    messages,
  } = input;

  const searchShown: {
    promo_id: string | number;
    h_id: string | number;
    name: string;
  }[] = [];

  const tools: GeminiTool[] = [
    {
      name: 'search_packages',
      description:
        'Search the live Oliday catalog for real, bookable holiday packages. Structured filters — use for any destination/nights/party ask. Returns up to 5 scored matches with a per-person price computed for THIS party size.',
      parameters: {
        type: 'object',
        properties: {
          destination: {
            type: 'string',
            description:
              'City or region the traveller asked for, as they said it (e.g. "Coorg", "Kashmir").',
          },
          nights: { type: 'integer', description: 'Trip length in nights.' },
          adults: { type: 'integer' },
          children: { type: 'integer' },
          mealPlan: {
            type: 'string',
            enum: ['ROOM_ONLY', 'BREAKFAST', 'BREAKFAST_DINNER', 'ALL_MEALS'],
          },
          vehicleType: {
            type: 'string',
            enum: ['HATCHBACK', 'SEDAN', 'SUV_MUV', 'TEMPO_TRAVELLER', 'MINI_BUS'],
          },
          // NOTE: no `enum` here — Gemini's schema dialect rejects
          // enums on non-string types with a 400 on EVERY call (the
          // failure that shipped the bot into permanent fallback
          // mode). The executor range-checks instead.
          starCategory: {
            type: 'integer',
            description: 'Hotel star preference: 3, 4, or 5.',
          },
          maxPrice: {
            type: 'number',
            description:
              'Per-person budget cap — ONLY if the traveller volunteered one; never ask for it.',
          },
        },
        required: ['destination'],
      },
      execute: async (raw) => {
        const result = await searchPackages({
          destination: String(raw.destination ?? ''),
          nights: numOrUndef(raw.nights),
          adults: numOrUndef(raw.adults),
          children: numOrUndef(raw.children),
          mealPlan: enumOrUndef(raw.mealPlan, [
            'ROOM_ONLY',
            'BREAKFAST',
            'BREAKFAST_DINNER',
            'ALL_MEALS',
          ]),
          vehicleType: enumOrUndef(raw.vehicleType, [
            'HATCHBACK',
            'SEDAN',
            'SUV_MUV',
            'TEMPO_TRAVELLER',
            'MINI_BUS',
          ]),
          starCategory: numOrUndef(raw.starCategory),
          maxPrice: numOrUndef(raw.maxPrice),
        });
        for (const p of result.packages) {
          searchShown.push({
            promo_id: p.promo_id,
            h_id: p.h_id,
            name: p.name,
          });
        }
        return result;
      },
    },
    {
      name: 'get_package',
      description:
        'Fetch ONE package in full — day-wise itinerary, every hotel, inclusions, exclusions, and the complete price matrix. REQUIRED before discussing any package in detail. Use the promo_id + h_id from a search result or the shown-packages list.',
      parameters: {
        type: 'object',
        properties: {
          promo_id: { type: 'string' },
          h_id: { type: 'string' },
        },
        required: ['promo_id', 'h_id'],
      },
      execute: async (raw) => {
        const row = await getPackage(
          String(raw.promo_id ?? ''),
          String(raw.h_id ?? '')
        );
        return row ?? { error: 'package not found — it may have expired' };
      },
    },
  ];

  const systemPrompt = buildOlidayPrompt({
    trip,
    today: new Date().toISOString().slice(0, 10),
    entryContext,
    adHeadline,
    phone,
    shownPackages,
  });

  const { text, usage } = await generateGeminiToolLoop({
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs: aiRequestTimeoutMs(),
    // This assistant is qualification-only. Keep the historical tool
    // declarations inert so no package/catalog call can occur.
    tools: tools.filter(() => false),
    maxToolRounds: 4,
    // Low temperature on purpose: the same ask should produce the
    // same behaviour (same slot question, same card format, reliable
    // JSON) — sales-bot consistency beats creative variety.
    temperature: 0.3,
  });

  return { parsed: parseAgentJson<AgentJson>(text), usage, searchShown };
}

// ------------------------------------------------------------
// State plumbing
// ------------------------------------------------------------

async function persistTrip(
  db: SupabaseClient,
  conversationId: string,
  trip: Trip,
  shownPackages:
    { promo_id: string | number; h_id: string | number; name: string }[] | null
): Promise<void> {
  const update: Record<string, unknown> = {
    trip,
    updated_at: new Date().toISOString(),
  };
  if (shownPackages) update.shown_packages = shownPackages;
  const { error } = await db
    .from('conversations')
    .update(update)
    .eq('id', conversationId);
  if (error) console.error('[oliday] trip persist failed:', error.message);
}

async function maybeSyncQualifiedTrip(input: {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  contactName: string | null;
  phone: string | null;
  referral: Record<string, unknown> | null;
  existingLeadId: string | null;
  trip: Trip;
}): Promise<Trip> {
  if (input.trip.crmLeadId) return input.trip;
  if (input.existingLeadId) return { ...input.trip, crmLeadId: input.existingLeadId };
  if (!input.phone || !isQualifiedTrip(input.trip)) return input.trip;
  try {
    const synced = await syncQualifiedTripToCrm({
      db: input.db,
      accountId: input.accountId,
      conversationId: input.conversationId,
      contact: { name: input.contactName, phone: input.phone, referral: input.referral },
      trip: input.trip,
    });
    return { ...input.trip, crmLeadId: synced.leadId, crmQualifiedAt: new Date().toISOString() };
  } catch (err) {
    // Keep replying and retry CRM sync on the next inbound message.
    console.error('[oliday] qualified lead CRM sync failed:', err instanceof Error ? err.message : err);
    return input.trip;
  }
}

function numOrUndef(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function enumOrUndef<T extends string>(
  v: unknown,
  allowed: T[]
): T | undefined {
  return typeof v === 'string' && (allowed as string[]).includes(v)
    ? (v as T)
    : undefined;
}
