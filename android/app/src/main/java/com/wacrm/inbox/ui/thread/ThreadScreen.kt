package com.wacrm.inbox.ui.thread

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.wacrm.inbox.BuildConfig
import com.wacrm.inbox.data.AppContainer
import com.wacrm.inbox.data.MessageRow
import com.wacrm.inbox.util.bubbleTime
import io.github.jan.supabase.auth.auth

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadScreen(
    container: AppContainer,
    conversationId: String,
    contactName: String,
    contactPhone: String,
    onBack: () -> Unit,
) {
    val vm: ThreadViewModel = viewModel(key = "thread/$conversationId") {
        ThreadViewModel(container, conversationId)
    }
    val state by vm.state.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    val snackbar = remember { SnackbarHostState() }

    BackHandler(onBack = onBack)

    // Transient send failures surface as a snackbar with Retry; the
    // draft is already restored in the composer by the ViewModel.
    LaunchedEffect(state.sendError) {
        val error = state.sendError ?: return@LaunchedEffect
        val result = snackbar.showSnackbar(error, actionLabel = "Retry", duration = SnackbarDuration.Long)
        if (result == SnackbarResult.ActionPerformed) vm.send()
    }

    // With reverseLayout, index 0 is the newest message — scroll there
    // whenever a new one lands.
    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(0)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(contactName, style = MaterialTheme.typography.titleMedium)
                        if (contactPhone.isNotBlank()) {
                            Text(contactPhone, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding(),
        ) {
            Box(Modifier.weight(1f)) {
                if (state.loading) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                } else {
                    val reversed = state.messages.asReversed()
                    LazyColumn(
                        state = listState,
                        reverseLayout = true,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(
                            horizontal = 12.dp,
                            vertical = 8.dp,
                        ),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        itemsIndexed(reversed, key = { _, m -> m.id }) { index, message ->
                            MessageBubble(container, message)
                            // Last rendered item == oldest loaded → page older.
                            if (index == reversed.lastIndex && !state.endReached) {
                                LaunchedEffect(message.id) { vm.loadOlder() }
                            }
                        }
                        if (state.loadingOlder) {
                            item {
                                Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                                }
                            }
                        }
                    }
                }
            }

            state.windowNotice?.let { notice ->
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            notice,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "Dismiss",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier
                                .clickable(onClick = vm::dismissWindowNotice)
                                .padding(4.dp),
                        )
                    }
                }
            }

            Composer(
                draft = state.draft,
                sending = state.sending,
                onDraftChange = vm::onDraftChange,
                onSend = vm::send,
            )
        }
    }
}

@Composable
private fun Composer(
    draft: String,
    sending: Boolean,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    Surface(tonalElevation = 3.dp) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = onDraftChange,
                placeholder = { Text("Message") },
                modifier = Modifier.weight(1f),
                maxLines = 5,
                shape = RoundedCornerShape(24.dp),
            )
            Spacer(Modifier.width(8.dp))
            IconButton(
                onClick = onSend,
                enabled = draft.isNotBlank() && !sending,
                modifier = Modifier.padding(bottom = 4.dp),
            ) {
                if (sending) {
                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                } else {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = "Send",
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(container: AppContainer, message: MessageRow) {
    val outbound = message.isOutbound
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (outbound) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            color = if (outbound) MaterialTheme.colorScheme.primaryContainer
            else MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(
                topStart = 12.dp,
                topEnd = 12.dp,
                bottomStart = if (outbound) 12.dp else 2.dp,
                bottomEnd = if (outbound) 2.dp else 12.dp,
            ),
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                BubbleContent(container, message)
                Spacer(Modifier.height(2.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (message.sender_type == "bot" || message.ai_generated == true) {
                        AiTag()
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        bubbleTime(message.createdAtMillis),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (outbound) {
                        Spacer(Modifier.width(4.dp))
                        StatusTicks(message.status)
                    }
                }
            }
        }
    }
}

@Composable
private fun BubbleContent(container: AppContainer, message: MessageRow) {
    when (message.content_type) {
        "text" -> Text(
            message.content_text ?: "",
            style = MaterialTheme.typography.bodyMedium,
        )

        "image" -> {
            val mediaUrl = message.media_url
            if (mediaUrl.isNullOrBlank()) {
                Placeholder("📷 Photo")
            } else {
                // Inbound media lives behind the CRM's authenticated proxy
                // (relative /api/whatsapp/media/<id>); pass the Bearer
                // header. Absolute URLs (rare) load as-is.
                val context = LocalContext.current
                val fullUrl = if (mediaUrl.startsWith("/")) BuildConfig.CRM_ORIGIN + mediaUrl else mediaUrl
                val token = container.supabase.auth.currentAccessTokenOrNull()
                val request = remember(fullUrl, token) {
                    ImageRequest.Builder(context)
                        .data(fullUrl)
                        .apply {
                            if (token != null && fullUrl.startsWith(BuildConfig.CRM_ORIGIN)) {
                                setHeader("Authorization", "Bearer $token")
                            }
                        }
                        .crossfade(true)
                        .build()
                }
                Column {
                    AsyncImage(
                        model = request,
                        contentDescription = "Photo",
                        contentScale = ContentScale.Crop,
                        error = androidx.compose.ui.res.painterResource(android.R.drawable.ic_menu_report_image),
                        modifier = Modifier
                            .widthIn(max = 260.dp)
                            .height(220.dp),
                    )
                    message.content_text?.takeIf { it.isNotBlank() }?.let {
                        Spacer(Modifier.height(4.dp))
                        Text(it, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }

        "video" -> Placeholder("🎬 Video")
        "audio" -> Placeholder("🎵 Audio")
        "document" -> Placeholder("📄 Document")
        "location" -> Placeholder("📍 Location")
        "template" -> Column {
            Placeholder("📋 Template")
            message.content_text?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(2.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium)
            }
        }

        "interactive" -> Column {
            Placeholder("Interactive message")
            message.content_text?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(2.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium)
            }
        }

        else -> Placeholder("Unsupported message")
    }
}

@Composable
private fun Placeholder(label: String) {
    Text(
        label,
        style = MaterialTheme.typography.bodyMedium,
        fontWeight = FontWeight.Medium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun AiTag() {
    Surface(
        color = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.18f),
        shape = RoundedCornerShape(4.dp),
    ) {
        Text(
            "AI",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.tertiary,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp),
        )
    }
}

/** WhatsApp-style ticks: sending 🕓, sent ✓, delivered ✓✓, read ✓✓ (accent), failed ⚠. */
@Composable
private fun StatusTicks(status: String) {
    val (symbol, color) = when (status) {
        "sending" -> "🕓" to MaterialTheme.colorScheme.onSurfaceVariant
        "sent" -> "✓" to MaterialTheme.colorScheme.onSurfaceVariant
        "delivered" -> "✓✓" to MaterialTheme.colorScheme.onSurfaceVariant
        "read" -> "✓✓" to MaterialTheme.colorScheme.tertiary
        "failed" -> "⚠" to MaterialTheme.colorScheme.error
        else -> "" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    if (symbol.isNotEmpty()) {
        Text(symbol, style = MaterialTheme.typography.labelSmall, color = color)
    }
}
