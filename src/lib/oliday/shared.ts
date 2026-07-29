// ============================================================
// Plumbing shared by the Oliday agents (packages + Vibes): the turn
// args, WhatsApp sending (plain / buttons / list with plain-text
// fallback), the per-conversation reply budget, and the conversation
// context builder that includes interactive turns.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiConfig, ChatMessage } from '@/lib/ai/types';
import {
  engineSendText,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send';

/** Bot replies per conversation before it goes quiet — a booking chat
 *  runs long, so this is far above the generic auto-reply cap but
 *  still a hard ceiling on runaway loops. Once hit, the thread simply
 *  waits in the inbox; "Resume AI" resets the budget. */
export const MAX_BOT_REPLIES = 60;

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

// ------------------------------------------------------------
// Context — includes interactive turns (button/list taps)
// ------------------------------------------------------------

export async function buildContext(
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

export async function sendPlain(
  args: OlidayTurnArgs,
  text: string
): Promise<void> {
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
export async function sendWithOptions(
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
// Model-output parsing
// ------------------------------------------------------------

/** Lenient JSON extraction: exact parse → fenced block → first {...}
 *  span → give up and treat the whole text as the reply. The models
 *  are instructed to emit bare JSON, but a mis-formatted turn must
 *  degrade to a sendable message, not a crash. */
export function parseAgentJson<T extends { response?: string }>(
  raw: string
): T {
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
        return parsed as T;
      }
    } catch {
      // try the next candidate
    }
  }
  return { response: raw.trim() } as T;
}

// ------------------------------------------------------------
// Budget + misc
// ------------------------------------------------------------

/** Atomic per-conversation reply budget — same RPC the generic
 *  auto-reply uses, with the bot-sized cap. Losing the claim means a
 *  concurrent turn just took the last slot; stand down quietly. */
export async function claimSlot(
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

export function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
