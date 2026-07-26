import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendMessageToConversation, SendMessageError } from './send-message';

// ============================================================
// 24-hour customer-service-window guard (acceptance test 9):
// free-form sends outside the window are refused with a typed
// error steering to templates — not silently dropped by Meta.
//
// The fake DB serves only the tables the guard path touches;
// reaching any LATER table (whatsapp_config) proves the guard
// let the send through.
// ============================================================

function chain(result: { data: unknown }) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit']) {
    c[m] = () => c;
  }
  c.single = () => Promise.resolve({ data: result.data, error: null });
  c.maybeSingle = () => Promise.resolve({ data: result.data, error: null });
  return c;
}

function windowDb(lastInboundAt: string | null): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'conversations') {
        return chain({
          data: {
            id: 'c1',
            account_id: 'acct-1',
            contact: { phone: '+919999999999' },
          },
        });
      }
      if (table === 'messages') {
        return chain({
          data: lastInboundAt ? { created_at: lastInboundAt } : null,
        });
      }
      throw new Error(`reached table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

const HOURS = 60 * 60 * 1000;

describe('24h window guard', () => {
  it('refuses a free-form send when the last inbound is >24h old', async () => {
    const stale = new Date(Date.now() - 25 * HOURS).toISOString();
    await expect(
      sendMessageToConversation(windowDb(stale), 'acct-1', {
        conversationId: 'c1',
        messageType: 'text',
        contentText: 'hello again',
      })
    ).rejects.toMatchObject({
      name: 'SendMessageError',
      code: 'outside_24h_window',
      status: 422,
    });
  });

  it('refuses when the customer has never messaged (business-initiated thread)', async () => {
    await expect(
      sendMessageToConversation(windowDb(null), 'acct-1', {
        conversationId: 'c1',
        messageType: 'text',
        contentText: 'hi',
      })
    ).rejects.toMatchObject({ code: 'outside_24h_window' });
  });

  it('lets a free-form send through when the window is open', async () => {
    const recent = new Date(Date.now() - 1 * HOURS).toISOString();
    // Passing the guard means reaching the NEXT table the send core
    // queries — the fake throws a recognisable marker there.
    await expect(
      sendMessageToConversation(windowDb(recent), 'acct-1', {
        conversationId: 'c1',
        messageType: 'text',
        contentText: 'hi',
      })
    ).rejects.toThrow('reached table: whatsapp_config');
  });

  it('skips the check for template sends (the re-engagement path)', async () => {
    await expect(
      sendMessageToConversation(windowDb(null), 'acct-1', {
        conversationId: 'c1',
        messageType: 'template',
        templateName: 'welcome_back',
      })
    ).rejects.toThrow('reached table: whatsapp_config');
  });

  it('SendMessageError shape is stable for API callers', () => {
    const err = new SendMessageError('outside_24h_window', 'msg', 422);
    expect(err.code).toBe('outside_24h_window');
    expect(err.status).toBe(422);
  });
});
