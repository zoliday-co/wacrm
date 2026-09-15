package com.wacrm.inbox.ui.inbox

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.wacrm.inbox.data.AppContainer
import com.wacrm.inbox.data.ChatRepository
import com.wacrm.inbox.data.ConversationRow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class InboxUiState(
    val conversations: List<ConversationRow> = emptyList(),
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val endReached: Boolean = false,
    val error: String? = null,
)

class InboxViewModel(private val container: AppContainer) : ViewModel() {

    private val repo = container.chatRepository
    private val _state = MutableStateFlow(InboxUiState())
    val state = _state.asStateFlow()

    init {
        refreshFirstPage(showSpinner = true)

        // Conversation INSERT/UPDATEs re-sort the list and refresh badges.
        // The payload has no embedded contact — merge over the known row,
        // or fetch the single row (with contact) if we've never seen it.
        viewModelScope.launch {
            container.realtimeManager.conversationChanges.collect { change ->
                val existing = _state.value.conversations.firstOrNull { it.id == change.id }
                if (existing != null) {
                    upsert(change.copy(contact = change.contact ?: existing.contact))
                } else {
                    val full = runCatching { repo.fetchConversation(change.id) }.getOrNull()
                    upsert(full ?: change)
                }
            }
        }

        // Each (re)subscribe refetches page 1 — catches up on anything
        // missed while the socket was down or the app was backgrounded.
        viewModelScope.launch {
            container.realtimeManager.subscribed.collect { refreshFirstPage(showSpinner = false) }
        }
    }

    fun refresh() {
        _state.update { it.copy(refreshing = true) }
        refreshFirstPage(showSpinner = false)
    }

    fun loadMore() {
        val s = _state.value
        if (s.loading || s.loadingMore || s.endReached) return
        _state.update { it.copy(loadingMore = true) }
        viewModelScope.launch {
            runCatching { repo.fetchConversations(offset = s.conversations.size) }
                .onSuccess { page ->
                    _state.update {
                        it.copy(
                            conversations = merge(it.conversations, page),
                            loadingMore = false,
                            endReached = page.size < ChatRepository.CONVERSATION_PAGE,
                        )
                    }
                }
                .onFailure { _state.update { it.copy(loadingMore = false) } }
        }
    }

    fun signOut() {
        viewModelScope.launch { container.authRepository.signOut() }
    }

    private fun refreshFirstPage(showSpinner: Boolean) {
        if (showSpinner) _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            runCatching { repo.fetchConversations(offset = 0) }
                .onSuccess { page ->
                    _state.update {
                        it.copy(
                            // Fresh page 1 wins; rows paged in earlier stay below.
                            conversations = merge(page, it.conversations),
                            loading = false,
                            refreshing = false,
                            error = null,
                        )
                    }
                }
                .onFailure {
                    _state.update {
                        it.copy(
                            loading = false,
                            refreshing = false,
                            error = if (it.conversations.isEmpty()) "Couldn't load conversations. Pull down to retry." else null,
                        )
                    }
                }
        }
    }

    private fun upsert(row: ConversationRow) {
        _state.update { s ->
            s.copy(conversations = merge(listOf(row), s.conversations))
        }
    }

    /** [primary] rows win over [secondary] duplicates; newest activity first. */
    private fun merge(primary: List<ConversationRow>, secondary: List<ConversationRow>): List<ConversationRow> =
        (primary + secondary.filter { c -> primary.none { it.id == c.id } })
            .sortedByDescending { it.lastMessageAtMillis }
}
