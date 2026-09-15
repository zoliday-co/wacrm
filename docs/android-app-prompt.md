# Build: wacrm Android app (inbox-only companion, native Kotlin)

> Prompt for the agent/developer building the mobile app. The backend
> work this app depends on is ALREADY DONE and deployed — see §3.

## 0. Before you write any code

This is a companion app to an EXISTING Next.js + Supabase WhatsApp CRM
(this repo). The backend is live — you are building a thin native
Android client. Read the repo first and verify these facts, then report
back with your plan (modules, screens) before building:

1. **How the web inbox reads data** — `src/hooks/use-realtime.ts`, the
   inbox components under `src/components/inbox/`, and the RLS
   policies in `supabase/migrations/` (001, 017). Reads are direct
   Supabase queries under the logged-in user's JWT; RLS scopes
   everything by account membership. You will do the same from Kotlin.
2. **How sending works** — `POST /api/whatsapp/send` →
   `sendMessageToConversation` in `src/lib/whatsapp/send-message.ts`.
   The Meta access token is AES-encrypted at rest and only decryptable
   server-side, so the app must NEVER call Meta's Graph API directly —
   every send goes through the CRM server.
3. **Bearer auth is already implemented server-side** — read
   `src/lib/supabase/server.ts`. Any API route that authenticates via
   `createClient()` accepts `Authorization: Bearer <supabase access
   token>` (a real JWT; RLS then runs as that user). This is the
   transport for ALL your server calls. Do NOT use the public
   `/api/v1` API-key path — it attributes sends to the key's audit
   user, not the logged-in agent.
4. **The media proxy** — inbound media is stored as a RELATIVE url
   (`/api/whatsapp/media/<mediaId>`) in `messages.media_url`. The
   route authenticates through the same `createClient()`, so it
   accepts the same Bearer header. Prefix with the deployment origin
   and pass the header when loading images.

## 1. What we're building

The smallest useful Android app for agents of this CRM:

- **Login** with Supabase Auth (email + password). NO sign-up, NO
  password reset, NO invite flow — accounts are created on the web.
  (Sign-ups fire a DB trigger that provisions a whole account; mobile
  must never trigger that path.)
- **Inbox** — list of conversations, newest activity first.
- **Thread** — messages of one conversation, live-updating.
- **Reply** — plain text sends only.

Explicit NON-GOALS (do not build): registration, broadcasts, flows,
automations, AI settings, templates, contact editing, deals/pipelines,
push notifications, media sending, voice notes. If a message type
isn't plain text, render a labeled placeholder bubble ("📷 Photo",
"🎵 Audio", "📄 Document", "Interactive message") — never crash.

## 2. Stack (fixed — do not substitute)

- **Kotlin, Jetpack Compose (Material 3), single-module app.**
- **supabase-kt** (`io.github.jan-tennert.supabase`) with the
  `auth-kt`, `postgrest-kt`, and `realtime-kt` modules + the Ktor
  OkHttp engine. Use its Android session persistence for auto-login.
- The one non-Supabase HTTP call (`/api/whatsapp/send`) goes through
  the same Ktor client with the Bearer header — no Retrofit.
- **Coil** for avatars and media images (per-request `Authorization`
  header for the media proxy).
- MVVM: one ViewModel per screen, Kotlin Flows end to end, no
  LiveData. minSdk 26, targetSdk latest stable. No DI framework —
  manual constructor injection is fine at this size.

## 3. Backend facts (verified — build against these)

Configuration via `BuildConfig` fields, values read from
`local.properties` (never committed):

```
SUPABASE_URL=https://ycagncvqkdoqntqrpofs.supabase.co
SUPABASE_ANON_KEY=<the NEXT_PUBLIC_SUPABASE_ANON_KEY from the CRM's env>
CRM_ORIGIN=https://wacrm-blond-eight.vercel.app
```

### Tables you read
RLS handles tenancy — no account_id filtering client-side; ordering
and limits are yours. Model these as `@Serializable` data classes with
exactly these column names.

`conversations`: id, contact_id, status, last_message_text,
last_message_at, unread_count, assigned_agent_id, ai_autoreply_disabled

`contacts`: id, name, phone, avatar_url

`messages`: id, conversation_id,
sender_type ('customer' | 'agent' | 'bot'),
content_type ('text' | 'image' | 'video' | 'audio' | 'document' |
'location' | 'template' | 'interactive'),
content_text, media_url,
status ('sending' | 'sent' | 'delivered' | 'read' | 'failed'),
ai_generated, created_at

Inbox query: conversations with an embedded contact join
(`select("*, contact:contacts(*)")`), order by `last_message_at` desc,
page by 30. Thread query: messages by conversation_id, order
`created_at` asc, last 50 with load-older pagination.

### Realtime
Subscribe via realtime-kt to postgres_changes on `messages` (INSERT)
and `conversations` (UPDATE) — the same events the web app consumes.
On message INSERT for the open thread, append; on conversation UPDATE,
re-sort the inbox row and refresh its badge. Tear down channels in
`onCleared`; resubscribe on app foreground (lifecycle-aware). The
realtime socket must carry the user's access token (supabase-kt does
this when the auth module holds the session) — without it, RLS blocks
every event and the app looks "working but silent".

### Opening a thread
Mirror the web: reset the unread badge with a Postgrest update
(`unread_count = 0` on that conversation). RLS permits it for account
members.

### Sending
`POST {CRM_ORIGIN}/api/whatsapp/send`
Headers: `Authorization: Bearer <supabase access token>`,
`Content-Type: application/json`
Body:

```json
{ "conversation_id": "<uuid>", "message_type": "text", "content_text": "..." }
```

Handle these responses explicitly:

- `422` with code `outside_24h_window` — the customer hasn't messaged
  in 24h; Meta forbids free-form sends. Show a clear inline notice
  ("Outside the 24-hour window — send a template from the web app"),
  do NOT retry.
- `401` — refresh the session via supabase-kt, retry once, else back
  to login. (Access tokens expire hourly — a send made with a stale
  token is the most common failure; always send the CURRENT token,
  not one captured at screen creation.)
- Network failure — keep the draft in the composer, offer retry.

Optimistic UI: append the message locally as 'sending', reconcile with
the realtime INSERT (or the POST response) — dedupe so it doesn't
render twice.

## 4. Screens (3 total)

1. **Login** — email, password, loading state, error states (wrong
   creds, no network). On success → Inbox. Session persists; app
   relaunch skips login.
2. **Inbox** — avatar or initials, contact name (fall back to phone),
   last_message_text one-liner, relative time, unread badge.
   Pull-to-refresh and an empty state.
3. **Thread** — header: contact name + phone. Bubbles: customer left,
   agent/bot right; bot messages get a small "AI" tag when
   `ai_generated`. Status ticks on outbound (sending / sent /
   delivered / read / failed). Composer pinned above the keyboard
   (imePadding). Media bubbles load via
   `{CRM_ORIGIN}{media_url}` with the Bearer header — on failure, the
   labeled placeholder, never a crash.

## 5. Acceptance tests — must pass end to end

1. Login with a real account → inbox shows the same conversations as
   the web app, in the same order.
2. Customer sends a WhatsApp message → appears in the open thread
   within ~2s without refresh; inbox row jumps to top with badge.
3. Reply from the app → status ticks progress (sent → delivered) via
   realtime; the message shows in the web inbox attributed to the
   logged-in agent.
4. Reply in a conversation whose last inbound is >24h old → clean
   inline error, no crash, no silent drop.
5. Kill and relaunch → still logged in, lands on inbox.
6. Wrong password → readable error, no crash.
7. A thread containing an image and an interactive message renders
   media/placeholders without crashing.
8. Access-token expiry mid-session → transparent refresh; a send after
   expiry still succeeds.
9. Rotate the device mid-thread → no state loss, no resubscribe storm.

## 6. Deliverables

- The investigation report from step 0 before any code.
- The Android project in a new top-level `android/` directory of this
  repo: Gradle (Kotlin DSL, version catalog), buildable with
  `./gradlew assembleDebug`, plus a README covering local.properties
  setup, running on an emulator, and building a release APK.
- Honest report of what is done, what is stubbed, and anything in the
  backend that blocked you.
