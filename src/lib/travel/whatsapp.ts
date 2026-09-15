// ============================================================
// WhatsApp sends for the travel layer — a thin wrapper over the
// shared `sendMessageToConversation` core (the SAME path the
// inbox composer and the public API use). Never throws: every
// outcome is returned so callers can record failures on the row
// that triggered the send and expose a retry.
//
// Strategy per send:
//   1. If an approved template is configured, send it (works
//      outside Meta's 24-hour window — the normal case for a
//      supplier who has never messaged us).
//   2. Otherwise send free text. If Meta's window is closed the
//      core throws `outside_24h_window`; we surface that code so
//      the UI can tell the agent to configure a template.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';

export interface TravelSendInput {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  text: string;
  template?: { name: string; language?: string | null; params: string[] } | null;
}

export type TravelSendResult =
  | { ok: true; messageId: string; whatsappMessageId: string; via: 'template' | 'text' }
  | { ok: false; code: string; error: string };

export async function sendTravelWhatsApp(input: TravelSendInput): Promise<TravelSendResult> {
  const { db, accountId, conversationId, text, template } = input;

  if (template?.name) {
    try {
      const r = await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'template',
        templateName: template.name,
        templateLanguage: template.language || 'en_US',
        templateParams: template.params,
        contentText: text,
      });
      return { ok: true, messageId: r.messageId, whatsappMessageId: r.whatsappMessageId, via: 'template' };
    } catch (err) {
      const mapped = mapError(err);
      console.warn('[travel/whatsapp] template send failed, falling back to text:', mapped.error);
      // fall through to text — inside the 24h window it still works
    }
  }

  try {
    const r = await sendMessageToConversation(db, accountId, {
      conversationId,
      messageType: 'text',
      contentText: text,
    });
    return { ok: true, messageId: r.messageId, whatsappMessageId: r.whatsappMessageId, via: 'text' };
  } catch (err) {
    const mapped = mapError(err);
    console.error('[travel/whatsapp] send failed:', mapped.code, mapped.error);
    return { ok: false, ...mapped };
  }
}

function mapError(err: unknown): { code: string; error: string } {
  if (err instanceof SendMessageError) return { code: err.code, error: err.message };
  return { code: 'unknown', error: err instanceof Error ? err.message : String(err) };
}

/**
 * Resolve (find-or-create) the WACRM conversation for a supplier's
 * WhatsApp number so supplier threads live in the shared inbox.
 * Returns null (and logs) when the number is missing/invalid.
 */
export async function resolveSupplierConversation(
  db: SupabaseClient,
  accountId: string,
  supplier: { id: string; name: string; whatsapp_phone: string | null; phone: string | null; contact_id: string | null }
): Promise<{ conversationId: string; contactId: string } | null> {
  const phone = supplier.whatsapp_phone || supplier.phone;
  if (!phone) return null;
  try {
    const resolved = await resolveConversationByPhone(db, accountId, phone, supplier.name);
    if (supplier.contact_id !== resolved.contactId) {
      await db.from('suppliers').update({ contact_id: resolved.contactId }).eq('id', supplier.id);
    }
    return { conversationId: resolved.conversationId, contactId: resolved.contactId };
  } catch (err) {
    console.error(
      '[travel/whatsapp] supplier conversation resolve failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
