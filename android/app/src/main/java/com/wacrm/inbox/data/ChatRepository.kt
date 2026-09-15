package com.wacrm.inbox.data

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order

/**
 * Direct Supabase reads/updates under the logged-in user's JWT — the
 * same queries the web inbox runs. RLS (migration 017) scopes every
 * row to the user's account.
 */
class ChatRepository(private val supabase: SupabaseClient) {

    companion object {
        const val CONVERSATION_PAGE = 30
        const val MESSAGE_PAGE = 50
        private val CONVERSATION_SELECT = Columns.raw("*, contact:contacts(*)")
    }

    /** Inbox page: newest activity first, contact embedded. */
    suspend fun fetchConversations(offset: Int = 0): List<ConversationRow> =
        supabase.from("conversations").select(CONVERSATION_SELECT) {
            order("last_message_at", Order.DESCENDING, nullsFirst = false)
            range(offset.toLong(), (offset + CONVERSATION_PAGE - 1).toLong())
        }.decodeList<ConversationRow>()

    /** Single conversation with contact — used when a realtime UPDATE
     *  arrives for a row the inbox hasn't loaded yet. */
    suspend fun fetchConversation(id: String): ConversationRow? =
        supabase.from("conversations").select(CONVERSATION_SELECT) {
            filter { eq("id", id) }
            limit(1)
        }.decodeList<ConversationRow>().firstOrNull()

    /**
     * Thread page, ascending. Fetches the newest [MESSAGE_PAGE] rows
     * before [beforeMillisOffset] pages older history (offset-based on
     * the descending query, then reversed for display).
     */
    suspend fun fetchMessages(conversationId: String, offset: Int = 0): List<MessageRow> =
        supabase.from("messages").select {
            filter { eq("conversation_id", conversationId) }
            order("created_at", Order.DESCENDING)
            range(offset.toLong(), (offset + MESSAGE_PAGE - 1).toLong())
        }.decodeList<MessageRow>().reversed()

    /** Mirror of the web thread: opening a conversation zeroes its badge.
     *  RLS permits the update for account members. */
    suspend fun resetUnread(conversationId: String) {
        supabase.from("conversations").update({
            set("unread_count", 0)
        }) {
            filter { eq("id", conversationId) }
        }
    }
}
