package com.wacrm.inbox.data

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.OffsetDateTime

/**
 * Rows mirror the CRM's Postgres schema (supabase/migrations 001 + 017
 * + 029) with exactly the column names PostgREST returns. RLS scopes
 * every read to the logged-in user's account, so no account_id
 * filtering happens client-side.
 */

@Serializable
data class ContactRow(
    val id: String,
    val name: String? = null,
    val phone: String? = null,
    val avatar_url: String? = null,
) {
    /** Contact name, falling back to phone, matching the web inbox. */
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: phone ?: "Unknown"
}

@Serializable
data class ConversationRow(
    val id: String,
    val contact_id: String? = null,
    val status: String? = null,
    val last_message_text: String? = null,
    val last_message_at: String? = null,
    val unread_count: Int = 0,
    val assigned_agent_id: String? = null,
    val ai_autoreply_disabled: Boolean? = null,
    /** Hydrated by the `contact:contacts(*)` embed on inbox queries.
     *  Absent on realtime UPDATE payloads — merge, don't overwrite. */
    val contact: ContactRow? = null,
) {
    val lastMessageAtMillis: Long get() = parseIsoMillis(last_message_at)
}

@Serializable
data class MessageRow(
    val id: String,
    val conversation_id: String,
    val sender_type: String, // 'customer' | 'agent' | 'bot'
    val content_type: String = "text", // text|image|video|audio|document|location|template|interactive
    val content_text: String? = null,
    val media_url: String? = null,
    val status: String = "sent", // sending|sent|delivered|read|failed
    val ai_generated: Boolean? = null,
    val created_at: String,
) {
    val createdAtMillis: Long get() = parseIsoMillis(created_at)
    val isOutbound: Boolean get() = sender_type == "agent" || sender_type == "bot"
}

/** Body of POST /api/whatsapp/send — plain text sends only. */
@Serializable
data class SendRequest(
    val conversation_id: String,
    val message_type: String = "text",
    val content_text: String,
)

/** PostgREST timestamptz strings ("2026-07-27T05:00:00.12345+00:00"). */
fun parseIsoMillis(iso: String?): Long {
    if (iso.isNullOrBlank()) return 0L
    return try {
        OffsetDateTime.parse(iso).toInstant().toEpochMilli()
    } catch (_: Exception) {
        try {
            Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            0L
        }
    }
}
