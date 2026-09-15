package com.wacrm.inbox.data

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.providers.builtin.Email
import io.github.jan.supabase.auth.status.SessionStatus
import io.github.jan.supabase.exceptions.RestException
import kotlinx.coroutines.flow.StateFlow

class AuthRepository(private val supabase: SupabaseClient) {

    val sessionStatus: StateFlow<SessionStatus> get() = supabase.auth.sessionStatus

    /**
     * Email + password sign-in only. There is deliberately NO sign-up
     * path here — a mobile-originated signUp would fire the CRM's DB
     * trigger that provisions a whole new account.
     */
    suspend fun signIn(email: String, password: String): Result<Unit> {
        return try {
            supabase.auth.signInWith(Email) {
                this.email = email.trim()
                this.password = password
            }
            Result.success(Unit)
        } catch (e: RestException) {
            // GoTrue answers 400 invalid_credentials for wrong email/password.
            Result.failure(IllegalArgumentException("Invalid email or password."))
        } catch (e: Exception) {
            Result.failure(Exception("Could not reach the server. Check your connection and try again."))
        }
    }

    suspend fun signOut() {
        try {
            supabase.auth.signOut()
        } catch (_: Exception) {
            // Offline sign-out: the local session is cleared regardless.
        }
    }
}
