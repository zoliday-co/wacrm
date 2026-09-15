package com.wacrm.inbox.data

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.realtime.PostgresAction
import io.github.jan.supabase.realtime.RealtimeChannel
import io.github.jan.supabase.realtime.channel
import io.github.jan.supabase.realtime.postgresChangeFlow
import io.github.jan.supabase.realtime.realtime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * One app-wide realtime channel over postgres_changes on `messages`
 * and `conversations` — the same events the web inbox consumes. The
 * socket carries the user's access token (auth-kt keeps it fresh), so
 * RLS admits exactly this account's rows; without it the subscription
 * "works" but stays silent.
 *
 * Screens collect the shared flows; AppContainer starts/stops the
 * channel on foreground+login / background+logout.
 */
class RealtimeManager(
    private val supabase: SupabaseClient,
    private val json: Json,
    private val scope: CoroutineScope,
) {

    private val _messageInserts = MutableSharedFlow<MessageRow>(extraBufferCapacity = 256)
    val messageInserts = _messageInserts.asSharedFlow()

    /** Status-tick progression (sent → delivered → read) arrives as UPDATEs. */
    private val _messageUpdates = MutableSharedFlow<MessageRow>(extraBufferCapacity = 256)
    val messageUpdates = _messageUpdates.asSharedFlow()

    private val _conversationChanges = MutableSharedFlow<ConversationRow>(extraBufferCapacity = 256)
    val conversationChanges = _conversationChanges.asSharedFlow()

    /** Fires on every (re)subscribe — screens refetch to catch up on
     *  events missed while the socket was down or the app backgrounded. */
    private val _subscribed = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
    val subscribed = _subscribed.asSharedFlow()

    private var channel: RealtimeChannel? = null
    private var collectJob: Job? = null
    private val mutex = Mutex()

    suspend fun start() {
        mutex.withLock {
            if (channel != null) return
            val ch = supabase.channel("android-inbox")

            // Flows must be registered before subscribe().
            val messageFlow = ch.postgresChangeFlow<PostgresAction>(schema = "public") {
                table = "messages"
            }
            val conversationFlow = ch.postgresChangeFlow<PostgresAction>(schema = "public") {
                table = "conversations"
            }

            collectJob = scope.launch {
                launch {
                    messageFlow.collect { action ->
                        when (action) {
                            is PostgresAction.Insert ->
                                decode<MessageRow>(action.record)?.let { _messageInserts.tryEmit(it) }

                            is PostgresAction.Update ->
                                decode<MessageRow>(action.record)?.let { _messageUpdates.tryEmit(it) }

                            else -> Unit
                        }
                    }
                }
                launch {
                    conversationFlow.collect { action ->
                        val record: JsonObject? = when (action) {
                            is PostgresAction.Insert -> action.record
                            is PostgresAction.Update -> action.record
                            else -> null
                        }
                        record?.let { decode<ConversationRow>(it) }
                            ?.let { _conversationChanges.tryEmit(it) }
                    }
                }
                launch {
                    ch.status.collect { status ->
                        if (status == RealtimeChannel.Status.SUBSCRIBED) _subscribed.tryEmit(Unit)
                    }
                }
            }

            channel = ch
            try {
                ch.subscribe()
            } catch (_: Exception) {
                // Socket down right now — realtime-kt retries; a later
                // start() after stop() also recovers.
            }
        }
    }

    suspend fun stop() {
        mutex.withLock {
            val ch = channel ?: return
            channel = null
            collectJob?.cancel()
            collectJob = null
            try {
                supabase.realtime.removeChannel(ch)
            } catch (_: Exception) {
            }
        }
    }

    private inline fun <reified T> decode(record: JsonObject): T? = try {
        json.decodeFromJsonElement(kotlinx.serialization.serializer(), record)
    } catch (_: Exception) {
        null // Never crash on an unexpected payload shape.
    }
}
