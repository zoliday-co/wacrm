// ============================================================
// In-app notifications for the travel layer. Reuses the existing
// `notifications` table (migration 027, widened in 048). Rows
// are inserted with the service-role client because the table
// deliberately has no client INSERT policy.
// ============================================================

import type { NotificationType } from '@/types';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export interface TravelNotificationInput {
  accountId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  travelLeadId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  actorUserId?: string | null;
}

export async function notifyUser(input: TravelNotificationInput): Promise<void> {
  const { error } = await supabaseAdmin().from('notifications').insert({
    account_id: input.accountId,
    user_id: input.userId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    travel_lead_id: input.travelLeadId ?? null,
    conversation_id: input.conversationId ?? null,
    contact_id: input.contactId ?? null,
    actor_user_id: input.actorUserId ?? null,
  });
  if (error) console.error('[travel/notifications] insert failed:', error.message);
}

/**
 * Notify the lead's assignee, or — when unassigned — every agent+
 * member of the account (small teams; everyone should see an
 * unclaimed callback).
 */
export async function notifyLeadOwners(
  input: Omit<TravelNotificationInput, 'userId'> & { assignedAgentId: string | null }
): Promise<void> {
  const admin = supabaseAdmin();
  let userIds: string[] = [];
  if (input.assignedAgentId) {
    userIds = [input.assignedAgentId];
  } else {
    const { data } = await admin
      .from('profiles')
      .select('user_id, account_role')
      .eq('account_id', input.accountId)
      .in('account_role', ['owner', 'admin', 'agent']);
    userIds = (data ?? []).map((p) => p.user_id as string);
  }
  await Promise.all(
    userIds
      .filter((id) => id !== input.actorUserId)
      .map((userId) => notifyUser({ ...input, userId }))
  );
}

/** Admins + owner (for approval requests). */
export async function notifyAdmins(
  input: Omit<TravelNotificationInput, 'userId'>
): Promise<void> {
  const admin = supabaseAdmin();
  const { data } = await admin
    .from('profiles')
    .select('user_id')
    .eq('account_id', input.accountId)
    .in('account_role', ['owner', 'admin']);
  await Promise.all(
    (data ?? [])
      .map((p) => p.user_id as string)
      .filter((id) => id !== input.actorUserId)
      .map((userId) => notifyUser({ ...input, userId }))
  );
}
