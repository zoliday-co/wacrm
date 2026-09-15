package com.wacrm.inbox.ui.thread

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.wacrm.inbox.data.AppContainer
import com.wacrm.inbox.data.ChatRepository
import com.wacrm.inbox.data.MessageRow
import com.wacrm.inbox.data.SendResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

data class ThreadUiState(
    val messages: List<MessageRow> = emptyList(),
    val loading: Boolean = true,
    val loadingOlder: Boolean = false,
    val endReached: Boolean = false,
    val draft: String = "",
    val sending: Boolean = false,
    /** Set on a 422 outside_24h_window — inline banner, no retry. */
    val windowNotice: String? = null,
    /** Transient send failure — the draft is restored; retry allowed. */
    val sendError: String? = null,
)

class ThreadViewModel(
    private val container: AppContainer,
    private val conversationId: String,
) : ViewModel() {

    private val repo = container.chatRepository
    private val _state = MutableStateFlow(ThreadUiState())
    val state = _state.asStateFlow()

    /** Optimistic bubbles awaiting their server row: temp id → text. */
    private val pendingTemps = LinkedHashMap<String, String>()

    init {
        loadLatest()

        // Live INSERTs for this thread. Dedupe against the optimistic
        // bubble: the realtime row can arrive before OR after the POST
        // response, so match by id first, then by pending outbound text.
        viewModelScope.launch {
            container.realtimeManager.messageInserts.collect { msg ->
                if (msg.conversation_id != conversationId) return@collect
                onServerMessage(msg)
                if (msg.sender_type == "customer") resetUnread()
            }
        }

        // Status-tick progression (sent → delivered → read) and edits.
        viewModelScope.launch {
            container.realtimeManager.messageUpdates.collect { msg ->
                if (msg.conversation_id != conversationId) return@collect
                _state.update { s ->
                    if (s.messages.none { it.id == msg.id }) s
                    else s.copy(messages = s.messages.map { if (it.id == msg.id) msg else it })
                }
            }
        }

        // After a resubscribe, refetch the tail to catch missed events.
        viewModelScope.launch {
            container.realtimeManager.subscribed.collect { loadLatest(silent = true) }
        }

        // Opening the thread zeroes the badge (mirrors the web inbox).
        resetUnread()
    }

    fun onDraftChange(value: String) = _state.update { it.copy(draft = value, sendError = null) }

    fun dismissWindowNotice() = _state.update { it.copy(windowNotice = null) }

    fun send() {
        val text = _state.value.draft.trim()
        if (text.isEmpty() || _state.value.sending) return

        val tempId = "temp-${UUID.randomUUID()}"
        val optimistic = MessageRow(
            id = tempId,
            conversation_id = conversationId,
            sender_type = "agent",
            content_type = "text",
            content_text = text,
            status = "sending",
            created_at = OffsetDateTime.now(ZoneOffset.UTC).toString(),
        )
        pendingTemps[tempId] = text
        _state.update {
            it.copy(
                draft = "",
                sending = true,
                sendError = null,
                windowNotice = null,
                messages = it.messages + optimistic,
            )
        }

        viewModelScope.launch {
            when (val result = container.sendApi.sendText(conversationId, text)) {
                is SendResult.Success -> {
                    pendingTemps.remove(tempId)
                    _state.update { s ->
                        val realId = result.messageId
                        val alreadyArrived = realId != null && s.messages.any { it.id == realId }
                        val messages = if (alreadyArrived) {
                            s.messages.filter { it.id != tempId }
                        } else {
                            s.messages.map {
                                if (it.id == tempId) it.copy(id = realId ?: tempId, status = "sent") else it
                            }
                        }
                        s.copy(sending = false, messages = messages)
                    }
                }

                is SendResult.OutsideWindow -> {
                    pendingTemps.remove(tempId)
                    _state.update { s ->
                        s.copy(
                            sending = false,
                            windowNotice = "Outside the 24-hour window — send a template from the web app.",
                            messages = s.messages.filter { it.id != tempId },
                            draft = s.draft.ifEmpty { text },
                        )
                    }
                }

                is SendResult.Unauthorized -> {
                    // Refresh already failed inside SendApi — session is dead.
                    container.authRepository.signOut()
                }

                is SendResult.Failure -> {
                    pendingTemps.remove(tempId)
                    _state.update { s ->
                        s.copy(
                            sending = false,
                            sendError = result.message,
                            // Keep the draft so the agent can retry.
                            draft = s.draft.ifEmpty { text },
                            messages = s.messages.filter { it.id != tempId },
                        )
                    }
                }
            }
        }
    }

    fun loadOlder() {
        val s = _state.value
        if (s.loading || s.loadingOlder || s.endReached) return
        _state.update { it.copy(loadingOlder = true) }
        viewModelScope.launch {
            val persisted = _state.value.messages.count { !it.id.startsWith("temp-") }
            runCatching { repo.fetchMessages(conversationId, offset = persisted) }
                .onSuccess { older ->
                    _state.update {
                        it.copy(
                            loadingOlder = false,
                            endReached = older.size < ChatRepository.MESSAGE_PAGE,
                            messages = mergeSorted(older, it.messages),
                        )
                    }
                }
                .onFailure { _state.update { it.copy(loadingOlder = false) } }
        }
    }

    private fun loadLatest(silent: Boolean = false) {
        if (!silent) _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            runCatching { repo.fetchMessages(conversationId, offset = 0) }
                .onSuccess { latest ->
                    _state.update {
                        it.copy(
                            loading = false,
                            endReached = latest.size < ChatRepository.MESSAGE_PAGE,
                            messages = mergeSorted(latest, it.messages),
                        )
                    }
                }
                .onFailure { _state.update { it.copy(loading = false) } }
        }
    }

    private fun onServerMessage(msg: MessageRow) {
        _state.update { s ->
            val byId = s.messages.any { it.id == msg.id }
            val messages = when {
                byId -> s.messages.map { if (it.id == msg.id) msg else it }

                else -> {
                    // Replace the matching optimistic bubble, if any.
                    val tempId = pendingTemps.entries.firstOrNull { (id, text) ->
                        msg.isOutbound && msg.content_text == text && s.messages.any { it.id == id }
                    }?.key
                    if (tempId != null) {
                        pendingTemps.remove(tempId)
                        s.messages.filter { it.id != tempId } + msg
                    } else {
                        s.messages + msg
                    }
                }
            }
            s.copy(messages = messages.sortedBy { it.createdAtMillis })
        }
    }

    private fun resetUnread() {
        viewModelScope.launch {
            runCatching { repo.resetUnread(conversationId) }
        }
    }

    private fun mergeSorted(fetched: List<MessageRow>, current: List<MessageRow>): List<MessageRow> {
        val extra = current.filter { c -> fetched.none { it.id == c.id } }
        return (fetched + extra).sortedBy { it.createdAtMillis }
    }
}
