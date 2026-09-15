package com.wacrm.inbox

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.wacrm.inbox.data.AppContainer
import io.github.jan.supabase.auth.status.SessionStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import com.wacrm.inbox.ui.inbox.InboxScreen
import com.wacrm.inbox.ui.login.LoginScreen
import com.wacrm.inbox.ui.theme.WacrmTheme
import com.wacrm.inbox.ui.thread.ThreadScreen

/** In-app navigation state. Lives in an Activity-scoped ViewModel so it
 *  survives rotation; no navigation library needed for 3 screens. */
sealed interface Screen {
    data object Inbox : Screen
    data class Thread(
        val conversationId: String,
        val contactName: String,
        val contactPhone: String,
    ) : Screen
}

class NavViewModel : ViewModel() {
    private val _screen = MutableStateFlow<Screen>(Screen.Inbox)
    val screen = _screen.asStateFlow()

    fun openThread(conversationId: String, name: String, phone: String) {
        _screen.value = Screen.Thread(conversationId, name, phone)
    }

    fun backToInbox() {
        _screen.value = Screen.Inbox
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as WacrmApp).container
        setContent {
            WacrmTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    Root(container)
                }
            }
        }
    }
}

@Composable
private fun Root(container: AppContainer) {
    val sessionStatus by container.authRepository.sessionStatus.collectAsStateWithLifecycle()
    val nav: NavViewModel = viewModel()
    val screen by nav.screen.collectAsStateWithLifecycle()

    when (sessionStatus) {
        is SessionStatus.Initializing -> Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator()
        }

        // RefreshFailure keeps the (stale) session — usually just a dead
        // network; auth-kt retries. Show the app rather than bounce to login.
        is SessionStatus.Authenticated, is SessionStatus.RefreshFailure -> when (val s = screen) {
            is Screen.Inbox -> InboxScreen(
                container = container,
                onOpenThread = nav::openThread,
            )

            is Screen.Thread -> ThreadScreen(
                container = container,
                conversationId = s.conversationId,
                contactName = s.contactName,
                contactPhone = s.contactPhone,
                onBack = nav::backToInbox,
            )
        }

        is SessionStatus.NotAuthenticated -> LoginScreen(container)
    }
}
