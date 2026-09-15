package com.wacrm.inbox.data

import com.wacrm.inbox.BuildConfig
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

sealed interface SendResult {
    /** Persisted server-side; [messageId] is the CRM `messages.id`. */
    data class Success(val messageId: String?) : SendResult

    /** 422 — Meta's 24h customer-service window is closed. Not retryable. */
    data class OutsideWindow(val message: String) : SendResult

    /** 401 even after a forced session refresh — back to login. */
    data object Unauthorized : SendResult

    data class Failure(val message: String, val retryable: Boolean) : SendResult
}

/**
 * The one non-Supabase call: POST {CRM_ORIGIN}/api/whatsapp/send with
 * the CURRENT Supabase access token. The CRM server owns the Meta
 * credentials (AES-encrypted at rest) — the app never talks to Meta.
 */
class SendApi(
    private val http: HttpClient,
    private val supabase: SupabaseClient,
    private val json: Json,
) {

    suspend fun sendText(conversationId: String, text: String): SendResult {
        val first = attempt(conversationId, text)
        if (first !is SendResult.Unauthorized) return first

        // Access tokens expire hourly. On 401: force a refresh, retry once
        // with the NEW token, and only then give up to the login screen.
        try {
            supabase.auth.refreshCurrentSession()
        } catch (_: Exception) {
            return SendResult.Unauthorized
        }
        return attempt(conversationId, text)
    }

    private suspend fun attempt(conversationId: String, text: String): SendResult {
        val token = supabase.auth.currentAccessTokenOrNull()
            ?: return SendResult.Unauthorized

        val response = try {
            http.post("${BuildConfig.CRM_ORIGIN}/api/whatsapp/send") {
                header(HttpHeaders.Authorization, "Bearer $token")
                contentType(ContentType.Application.Json)
                setBody(json.encodeToString(SendRequest.serializer(), SendRequest(conversationId, "text", text)))
            }
        } catch (e: Exception) {
            return SendResult.Failure(
                "Couldn't reach the server. Message not sent.",
                retryable = true,
            )
        }

        val status = response.status.value
        val body = try {
            response.bodyAsText()
        } catch (_: Exception) {
            ""
        }

        fun errorMessage(fallback: String): String = try {
            json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.content ?: fallback
        } catch (_: Exception) {
            fallback
        }

        return when {
            status in 200..299 -> {
                val messageId = try {
                    json.parseToJsonElement(body).jsonObject["message_id"]?.jsonPrimitive?.content
                } catch (_: Exception) {
                    null
                }
                SendResult.Success(messageId)
            }

            status == 401 -> SendResult.Unauthorized

            // The dashboard send route answers 422 only for
            // outside_24h_window (send-message.ts) — a free-form send when
            // the customer hasn't messaged in 24h. Meta requires a template.
            status == 422 -> SendResult.OutsideWindow(
                errorMessage("Outside the 24-hour window — send a template from the web app."),
            )

            status == 429 -> SendResult.Failure("Sending too fast — wait a moment and retry.", retryable = true)

            else -> SendResult.Failure(errorMessage("Send failed ($status)."), retryable = true)
        }
    }
}
