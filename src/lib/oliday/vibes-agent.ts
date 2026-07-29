// ============================================================
// The Vibes agent turn — runs when the orchestration layer in
// `agent.ts` routes a conversation to Vibes (the `(vibes:<tripId>)`
// tag or a generic Vibes enquiry; sticky thereafter).
//
// Mirrors the packages agent's contract: NEVER throws, never goes
// silent (deterministic fallback on LLM failure), never pauses
// itself — humans take over only manually from the inbox. A mid-chat
// packages/pricing ask returns 'switch_to_packages' so the caller
// hands the same inbound to the packages agent.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
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
  sendWithOptions,
  type OlidayTurnArgs,
} from './shared';
import { buildVibesPrompt } from './vibes-prompt';
import {
  mergeVibes,
  stripVibesTag,
  vibesFallback,
  type VibesState,
} from './vibes';
import { getVibeTrip, listOpenVibeTrips } from './vibes-trips';

interface VibesJson {
  vibeTripId?: unknown;
  extractedFields?: unknown;
  stage?: unknown;
  requestIntent?: boolean;
  handoffConfirmed?: boolean;
  needsSpecialist?: boolean;
  switchToPackages?: boolean;
  isRelevant?: boolean;
  response?: string;
  options?: unknown;
}

export type VibesTurnResult = 'done' | 'switch_to_packages';

export async function runVibesTurn(
  args: OlidayTurnArgs & { state: VibesState }
): Promise<VibesTurnResult> {
  const { db, accountId, conversationId, contactId, config } = args;
  let state = args.state;

  try {
    const messages = await buildContext(db, conversationId);
    if (messages.length === 0) return 'done';

    const { data: contactRow } = await db
      .from('contacts')
      .select('phone')
      .eq('id', contactId)
      .maybeSingle();
    const phone =
      typeof contactRow?.phone === 'string' && contactRow.phone.trim()
        ? contactRow.phone.trim()
        : null;

    // ---- The LLM turn (one retry, then deterministic fallback) --
    let result: {
      parsed: VibesJson;
      usage: Parameters<typeof logAiUsage>[1]['usage'];
    } | null = null;

    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        const { text, usage } = await generateGeminiToolLoop({
          apiKey: config.apiKey,
          model: config.model,
          systemPrompt: buildVibesPrompt({
            state,
            today: new Date().toISOString().slice(0, 10),
            phone,
          }),
          messages,
          timeoutMs: aiRequestTimeoutMs(),
          tools: vibesTools(),
          maxToolRounds: 4,
          temperature: 0.3,
        });
        result = { parsed: parseAgentJson<VibesJson>(text), usage };
      } catch (err) {
        console.error(
          `[oliday vibes] generation attempt ${attempt + 1} failed:`,
          err instanceof AiError ? `${err.code}: ${err.message}` : err
        );
      }
    }

    if (!result) {
      // LLM down — never go silent. Safe canned line for the stage.
      await persistVibes(db, conversationId, state);
      const q = vibesFallback(state);
      if (!(await claimSlot(db, conversationId))) return 'done';
      await sendWithOptions(args, q.text, q.options);
      return 'done';
    }

    // ---- Merge state, log flags -------------------------------
    state = mergeVibes(state, result.parsed);

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    });

    // Advisory only — the team reads the inbox and steps in manually;
    // the bot never pauses itself or assigns anyone.
    if (result.parsed.needsSpecialist === true) {
      console.log(
        `[oliday vibes] specialist flagged on conversation ${conversationId}` +
          (state.handoffConfirmed ? ' (recap confirmed)' : '')
      );
    }
    if (result.parsed.handoffConfirmed === true) {
      console.log(
        `[oliday vibes] recap CONFIRMED on conversation ${conversationId} — a specialist should follow up.`
      );
    }

    // ---- Mid-chat packages ask → hand the turn back ------------
    // Send the model's one-line warm bridge (if any), mark the route
    // inactive, and let the caller run the packages agent on this
    // same inbound.
    const responseText = stripVibesTag(
      typeof result.parsed.response === 'string' ? result.parsed.response : ''
    );
    if (result.parsed.switchToPackages === true) {
      state = { ...state, active: false };
      await persistVibes(db, conversationId, state);
      if (responseText) {
        if (!(await claimSlot(db, conversationId))) return 'done';
        await sendWithOptions(args, responseText, []);
      }
      return 'switch_to_packages';
    }

    await persistVibes(db, conversationId, state);

    if (!responseText) {
      // Model returned JSON with no message — soft failure, not an
      // empty bubble.
      const q = vibesFallback(state);
      if (!(await claimSlot(db, conversationId))) return 'done';
      await sendWithOptions(args, q.text, q.options);
      return 'done';
    }

    // ---- Send, with quick replies where provided ---------------
    if (!(await claimSlot(db, conversationId))) return 'done';
    const options = Array.isArray(result.parsed.options)
      ? result.parsed.options
          .filter((o): o is string => typeof o === 'string' && o.trim() !== '')
          .map((o) => stripVibesTag(o))
          .slice(0, 10)
      : [];
    await sendWithOptions(args, responseText, options);
    return 'done';
  } catch (err) {
    console.error('[oliday vibes] turn failed:', err);
    return 'done';
  }
}

// ------------------------------------------------------------
// Tools — the agent's only source of trip facts (spec §2)
// ------------------------------------------------------------

function vibesTools(): GeminiTool[] {
  return [
    {
      name: 'get_vibes_trip',
      description:
        'Fetch ONE Vibes trip by id: title, route (startCity → destination), month, length, group type, spots left, host name and description. REQUIRED before stating any fact about a trip.',
      parameters: {
        type: 'object',
        properties: {
          tripId: {
            type: 'string',
            description: 'The trip id (from the entry tag or a listing).',
          },
        },
        required: ['tripId'],
      },
      execute: async (raw) => {
        const trip = await getVibeTrip(String(raw.tripId ?? ''));
        return trip ?? { error: 'trip not found — it may have been closed' };
      },
    },
    {
      name: 'list_open_trips',
      description:
        'List the Vibes trips currently OPEN for join requests (newest first): id, title, route, month, length, group type, spots left, host. Use before showing or recommending trips.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const trips = await listOpenVibeTrips();
        return trips.length > 0
          ? { trips }
          : { trips: [], note: 'no open trips right now' };
      },
    },
  ];
}

// ------------------------------------------------------------
// State plumbing
// ------------------------------------------------------------

async function persistVibes(
  db: SupabaseClient,
  conversationId: string,
  state: VibesState
): Promise<void> {
  const { error } = await db
    .from('conversations')
    .update({ vibes: state, updated_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (error) console.error('[oliday vibes] state persist failed:', error.message);
}
