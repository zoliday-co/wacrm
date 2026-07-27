import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies, headers } from 'next/headers'

/**
 * Request-scoped Supabase client for server code (API routes, server
 * components). Two auth transports:
 *
 *   1. Cookies (the default) — the web dashboard, via @supabase/ssr.
 *   2. `Authorization: Bearer <supabase access token>` — non-browser
 *      clients (the Android companion app) that hold a Supabase
 *      session but have no cookie jar. The token is passed through to
 *      PostgREST, so RLS runs as that user — exactly like the cookie
 *      path — and `auth.getUser()` is bound to it so existing route
 *      code works unchanged.
 *
 * The bearer branch only engages for values shaped like a JWT
 * (three dot-separated segments). That keeps it out of the way of the
 * OTHER bearer scheme in this app — public-API keys
 * (`Authorization: Bearer wacrm_live_…`, handled by `requireApiKey`)
 * — and of the cron secret, neither of which should ever be mistaken
 * for a user session. A bogus JWT fails `getUser()` and PostgREST
 * verification, so routes 401 exactly as they would with no session.
 */
export async function createClient() {
  const headerStore = await headers()
  const authHeader = headerStore.get('authorization') ?? ''
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice('bearer '.length).trim()
    : ''

  if (bearer && looksLikeJwt(bearer)) {
    const client = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        // Every PostgREST/Storage/Realtime request carries the user's
        // token — RLS applies as usual.
        global: { headers: { Authorization: `Bearer ${bearer}` } },
        // Stateless per-request client: nothing to persist or refresh
        // server-side. The mobile client owns its own session refresh.
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      }
    )
    // Route code calls `auth.getUser()` with no argument and expects
    // the cookie session to back it. There is no session here, so bind
    // the parameterless form to the bearer token (an explicit argument
    // still wins).
    const getUser = client.auth.getUser.bind(client.auth)
    client.auth.getUser = (jwt?: string) => getUser(jwt ?? bearer)
    return client
  }

  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  )
}

/** Supabase access tokens are JWTs: three non-empty dot-separated
 *  segments. API keys (`wacrm_live_…`) and other bearer values are
 *  not, and must fall through to the cookie path untouched. */
function looksLikeJwt(token: string): boolean {
  const parts = token.split('.')
  return parts.length === 3 && parts.every((p) => p.length > 0)
}
