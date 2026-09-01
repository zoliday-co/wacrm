// ============================================================
// The Niko turn — a personal assistant on WhatsApp, routed to by
// phone number (see `env.ts`) instead of the Oliday agents.
//
// Contract, identical to the Oliday agents so the dispatcher can treat
// them interchangeably: NEVER throws (the webhook's 200 to Meta must
// not depend on a model call), never goes silent (a dead LLM falls back
// to a deterministic question), never pauses itself — a human takes
// over manually from the inbox.
//
// State lives on `conversations.niko`, mirroring `.trip` (packages) and
// `.vibes`. Fulfilment is manual in the MVP: Niko collects a complete,
// confirmed request and logs it for a human to action.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { AiError } from '@/lib/ai/types';
import { aiRequestTimeoutMs } from '@/lib/ai/defaults';
import { logAiUsage } from '@/lib/ai/usage';
import { generateGemini } from '@/lib/ai/providers/gemini';
import {
  buildContext,
  claimSlot,
  parseAgentJson,
  sendWithOptions,
  type OlidayTurnArgs,
} from '@/lib/oliday/shared';
import { buildNikoPrompt } from './prompt';
import { mergeNiko, nikoFallback, parseNiko, type NikoState } from './state';

/** Niko's own args are the shared turn args — same plumbing, different
 *  agent. Aliased so call sites read honestly. */
export type NikoTurnArgs = OlidayTurnArgs;

interface NikoJson {
  service?: unknown;
  extractedFields?: unknown;
  preferences?: unknown;
  requestConfirmed?: unknown;
  /** Typed as string to satisfy parseAgentJson, which falls back to
   *  wrapping unparseable model output as { response }. Still checked
   *  at the use site — the model can put anything here. */
  response?: string;
  options?: unknown;
}

const MEDIA_ACK =
  "Got it — I can't open attachments just yet, but I'll get a human to look. In the meantime, tell me in a line what you need and I'll take it from there.";

export async function runNikoTurn(args: NikoTurnArgs): Promise<void> {
  const { db, accountId, conversationId, contactId, config, inbound } = args;

  try {
    // Media has nothing to model against — acknowledge rather than
    // ignore, so a prescription photo never lands in silence.
    if (inbound.contentType !== 'text' && !inbound.interactiveReplyId) {
      if (!(await claimSlot(db, conversationId))) return;
      await sendWithOptions(args, MEDIA_ACK, []);
      return;
    }

    const { data: convRow } = await db
      .from('conversations')
      .select('niko')
      .eq('id', conversationId)
      .maybeSingle();
    let state = parseNiko(convRow?.niko);

    const messages = await buildContext(db, conversationId);
    if (messages.length === 0) return;

    const { data: contactRow } = await db
      .from('contacts')
      .select('name')
      .eq('id', contactId)
      .maybeSingle();
    const name =
      typeof contactRow?.name === 'string' && contactRow.name.trim()
        ? contactRow.name.trim()
        : null;

    const today = new Date().toISOString().slice(0, 10);

    // ---- The LLM turn (one retry, then deterministic fallback) ----
    let result: {
      parsed: NikoJson;
      usage: Parameters<typeof logAiUsage>[1]['usage'];
    } | null = null;

    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        const { text, usage } = await generateGemini({
          apiKey: config.apiKey,
          model: config.model,
          systemPrompt: buildNikoPrompt({ state, today, name }),
          messages,
          timeoutMs: aiRequestTimeoutMs(),
        });
        result = { parsed: parseAgentJson<NikoJson>(text), usage };
      } catch (err) {
        console.error(
          `[niko] generation attempt ${attempt + 1} failed:`,
          err instanceof AiError ? `${err.code}: ${err.message}` : err
        );
      }
    }

    if (!result) {
      // Model unreachable — ask the next question ourselves rather than
      // leaving the user staring at a delivered tick.
      const q = nikoFallback(state);
      if (!(await claimSlot(db, conversationId))) return;
      await sendWithOptions(args, q.text, q.options);
      return;
    }

    const before = state.stage;
    state = mergeNiko(state, result.parsed, today);

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    });

    await persistNiko(db, conversationId, state);

    // A request just went from collected to confirmed. Fulfilment is
    // manual, so this log line IS the handoff — it names the request a
    // human now owes the user.
    if (state.stage === 'submitted' && before !== 'submitted') {
      console.log(
        `[niko] REQUEST CONFIRMED on conversation ${conversationId}:`,
        JSON.stringify({ service: state.service, fields: state.fields })
      );
    }

    const responseText =
      typeof result.parsed.response === 'string' ? result.parsed.response.trim() : '';
    if (!responseText) {
      const q = nikoFallback(state);
      if (!(await claimSlot(db, conversationId))) return;
      await sendWithOptions(args, q.text, q.options);
      return;
    }

    if (!(await claimSlot(db, conversationId))) return;
    const options = Array.isArray(result.parsed.options)
      ? result.parsed.options
          .filter((o): o is string => typeof o === 'string' && o.trim() !== '')
          .slice(0, 10)
      : [];
    await sendWithOptions(args, responseText, options);
  } catch (err) {
    console.error('[niko] turn failed:', err);
  }
}

async function persistNiko(
  db: SupabaseClient,
  conversationId: string,
  state: NikoState
): Promise<void> {
  const { error } = await db
    .from('conversations')
    .update({ niko: state, updated_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (error) console.error('[niko] state persist failed:', error.message);
}
