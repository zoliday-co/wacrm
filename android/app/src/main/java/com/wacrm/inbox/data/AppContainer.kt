package com.wacrm.inbox.data

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.wacrm.inbox.BuildConfig
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.Auth
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.status.SessionStatus
import io.github.jan.supabase.createSupabaseClient
import io.github.jan.supabase.postgrest.Postgrest
import io.github.jan.supabase.realtime.Realtime
import io.github.jan.supabase.serializer.KotlinXSerializer
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/**
 * Manual DI root, owned by the Application. Builds the Supabase client
 * (auth + postgrest + realtime), the plain Ktor client used for
 * /api/whatsapp/send, and the repositories, and keeps the realtime
 * channel alive exactly while (app is foregrounded AND a user is
 * logged in) — lifecycle-aware, unaffected by rotation.
 */
class AppContainer(context: Context) {

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
    }

    val supabase: SupabaseClient = createSupabaseClient(
        supabaseUrl = BuildConfig.SUPABASE_URL,
        supabaseKey = BuildConfig.SUPABASE_ANON_KEY,
    ) {
        defaultSerializer = KotlinXSerializer(json)
        // Auth on Android persists the session and auto-refreshes tokens
        // by default — app relaunch skips login; the realtime socket and
        // every PostgREST call carry the current (refreshed) user JWT so
        // RLS sees the logged-in agent.
        install(Auth)
        install(Postgrest)
        install(Realtime)
    }

    /** Non-Supabase HTTP: the CRM send endpoint (Bearer-authenticated). */
    val httpClient = HttpClient(OkHttp)

    val authRepository = AuthRepository(supabase)
    val chatRepository = ChatRepository(supabase)
    val sendApi = SendApi(httpClient, supabase, json)
    val realtimeManager = RealtimeManager(supabase, json, appScope)

    private val foregrounded = MutableStateFlow(false)

    init {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                foregrounded.value = true
            }

            override fun onStop(owner: LifecycleOwner) {
                foregrounded.value = false
            }
        })

        // Single app-wide channel (mirrors the web inbox, which
        // subscribes to messages + conversations globally and lets RLS
        // scope the events). Up while foregrounded and authenticated;
        // torn down on background/logout; resubscribed on return.
        appScope.launch {
            combine(foregrounded, supabase.auth.sessionStatus) { fg, session ->
                fg && session is SessionStatus.Authenticated
            }
                .distinctUntilChanged()
                .collect { active ->
                    if (active) realtimeManager.start() else realtimeManager.stop()
                }
        }
    }
}
