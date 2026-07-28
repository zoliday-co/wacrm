// ============================================================
// The Oliday agent turn — invoked from `dispatchInboundToAiReply`
// when the bot is enabled and the account runs provider='gemini'.
//
// Owns everything the generic auto-reply doesn't:
//   - debounce (rapid-fire messages collapse into one turn)
//   - non-text inbound → graceful ack (the bot stays on the case)
//   - trip-slot state on `conversations.trip` (source of truth)
//   - the Gemini function-calling loop over search_packages /
//     get_package (retrieval-grounded — §7)
//   - interactive quick replies (buttons ≤3, list 4–10)
//   - deterministic fallback on LLM failure (the bot never goes
//     silent on an inbound)
//
// The bot NEVER hands off on its own — no self-pause, no auto-assign.
// A human takes over only manually via the inbox "Take over" action.
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
  engineSendText,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send';
import { searchPackages } from './search';
import { getPackage } from './package';
import { buildOlidayPrompt } from './prompt';
import { parseDealLink, tripFromDealLink } from './entry';
import {
  mergeTrip,
  fallbackQuestion,
  deterministicExtract,
  type Trip,
} from './trip';

/** Rapid-fire messages ("Kashmir" / "5 nights" / "2 of us" in three
 *  bubbles) collapse into one turn: wait for this much silence, then
 *  only the invocation holding the newest message proceeds. */
const DEBOUNCE_MS = 2500;

/** Bot replies per conversation before it goes quiet — a booking chat
 *  runs long, so this is far above the generic auto-reply cap but
 *  still a hard ceiling on runaway loops. Once hit, the thread simply
 *  waits in the inbox; "Resume AI" resets the budget. */
const MAX_BOT_REPLIES = 60;

const MEDIA_ACK =
  "Thanks for sharing! I can't open attachments here just yet — our team will take a look. Meanwhile, tell me a bit more in text and I'll keep planning your trip right here.";

export interface OlidayInbound {
  contentType: string;
  text: string;
  interactiveReplyId: string | null;
  wamid: string;
}

export interface OlidayTurnArgs {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
  config: AiConfig;
  inbound: OlidayInbound;
}

interface AgentJson {
  extractedFields?: unknown;
  response?: string;
  options?: unknown;
  /** Legacy field older prompts taught — ignored: the bot never hands
   *  off on its own. */
  handoff?: boolean;
}

export async function runOlidayTurn(args: OlidayTurnArgs): Promise<void> {
  const { db, accountId, conversationId, contactId, config, inbound } = args;

  try {
    // ---- Load bot state ----------------------------------------
    const { data: conv } = await db
      .from('conversations')
      .select('trip, shown_packages, entry_context')
      .eq('id', conversationId)
      .maybeSingle();
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

    // ---- Ad attribution for the opening line -------------------
    const { data: contactRow } = await db
      .from('contacts')
      .select('referral')
      .eq('id', contactId)
      .maybeSingle();
    const adHeadline =
      contactRow?.referral &&
      typeof (contactRow.referral as Record<string, unknown>).headline ===
        'string'
        ? ((contactRow.referral as Record<string, unknown>).headline as string)
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
      await persistTrip(db, conversationId, trip, null);
      const q = fallbackQuestion(trip);
      if (!(await claimSlot(db, conversationId))) return;
      await sendWithOptions(args, q.text, q.options);
      return;
    }

    // ---- Merge extraction --------------------------------------
    trip = mergeTrip(trip, result.parsed.extractedFields);

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    });

    const responseText =
      typeof result.parsed.response === 'string'
        ? result.parsed.response.trim()
        : '';

    await persistTrip(
      db,
      conversationId,
      trip,
      result.searchShown.length > 0 ? result.searchShown : null
    );

    if (!responseText) {
      // Model returned JSON with no message — treat as a soft failure
      // rather than sending an empty bubble.
      const q = fallbackQuestion(trip);
      if (!(await claimSlot(db, conversationId))) return;
      await sendWithOptions(args, q.text, q.options);
      return;
    }

    // ---- Send, with quick replies where provided ---------------
    if (!(await claimSlot(db, conversationId))) return;
    const options = Array.isArray(result.parsed.options)
      ? result.parsed.options
          .filter((o): o is string => typeof o === 'string' && o.trim() !== '')
          .slice(0, 10)
      : [];
    await sendWithOptions(args, responseText, options);
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
  const { config, trip, entryContext, adHeadline, shownPackages, messages } =
    input;

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
            enum: ['SEDAN', 'SUV_MUV', 'TEMPO_TRAVELLER', 'MINI_BUS'],
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
    shownPackages,
  });

  const { text, usage } = await generateGeminiToolLoop({
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs: aiRequestTimeoutMs(),
    tools,
    maxToolRounds: 4,
    // Low temperature on purpose: the same ask should produce the
    // same behaviour (same slot question, same card format, reliable
    // JSON) — sales-bot consistency beats creative variety.
    temperature: 0.3,
  });

  return { parsed: parseAgentJson(text), usage, searchShown };
}

/** Lenient JSON extraction: exact parse → fenced block → first {...}
 *  span → give up and treat the whole text as the reply. The model is
 *  instructed to emit bare JSON, but a mis-formatted turn must
 *  degrade to a sendable message, not a crash. */
export function parseAgentJson(raw: string): AgentJson {
  const candidates: string[] = [raw.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced) candidates.push(fenced[1].trim());
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(raw.slice(braceStart, braceEnd + 1));
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as AgentJson;
      }
    } catch {
      // try the next candidate
    }
  }
  return { response: raw.trim() };
}

// ------------------------------------------------------------
// Context — includes interactive turns (button/list taps)
// ------------------------------------------------------------

async function buildContext(
  db: SupabaseClient,
  conversationId: string,
  limit = 30
): Promise<ChatMessage[]> {
  const { data } = await db
    .from('messages')
    .select('sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'interactive'])
    .order('created_at', { ascending: false })
    .limit(limit);

  const rows = (
    (data ?? []) as {
      sender_type: 'customer' | 'agent' | 'bot';
      content_type: string;
      content_text: string | null;
    }[]
  ).reverse();

  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role:
        m.sender_type === 'customer'
          ? ('user' as const)
          : ('assistant' as const),
      content: m.content_text!.trim(),
    }));
}

// ------------------------------------------------------------
// Sending
// ------------------------------------------------------------

async function sendPlain(args: OlidayTurnArgs, text: string): Promise<void> {
  await engineSendText({
    accountId: args.accountId,
    userId: args.configOwnerUserId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    text,
    aiGenerated: true,
  });
}

/** 0 options → text · 1–3 → reply buttons · 4–10 → list message.
 *  Meta caps: button titles 20 chars, list row titles 24. If the
 *  interactive send fails (e.g. a title Meta rejects), fall back to
 *  plain text with numbered options — never lose the turn. */
async function sendWithOptions(
  args: OlidayTurnArgs,
  text: string,
  options: string[]
): Promise<void> {
  const base = {
    accountId: args.accountId,
    userId: args.configOwnerUserId,
    conversationId: args.conversationId,
    contactId: args.contactId,
  };
  try {
    if (options.length === 0) {
      await sendPlain(args, text);
    } else if (options.length <= 3) {
      await engineSendInteractiveButtons({
        ...base,
        bodyText: text,
        buttons: options.map((o, i) => ({
          id: `opt_${i}`,
          title: truncate(o, 20),
        })),
      });
    } else {
      await engineSendInteractiveList({
        ...base,
        bodyText: text,
        buttonLabel: 'Choose',
        sections: [
          {
            title: 'Options',
            rows: options.map((o, i) => ({
              id: `opt_${i}`,
              title: truncate(o, 24),
            })),
          },
        ],
      });
    }
  } catch (err) {
    console.error(
      '[oliday] interactive send failed, falling back to text:',
      err
    );
    const numbered = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
    await sendPlain(args, numbered ? `${text}\n\n${numbered}` : text);
  }
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

/** Atomic per-conversation reply budget — same RPC the generic
 *  auto-reply uses, with the bot-sized cap. Losing the claim means a
 *  concurrent turn just took the last slot; stand down quietly. */
async function claimSlot(
  db: SupabaseClient,
  conversationId: string
): Promise<boolean> {
  const { data, error } = await db.rpc('claim_ai_reply_slot', {
    conversation_id: conversationId,
    max_replies: MAX_BOT_REPLIES,
  });
  if (error) {
    console.error('[oliday] claim_ai_reply_slot failed:', error);
    return false;
  }
  return data === true;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
