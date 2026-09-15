# wacrm Android (inbox companion)

The smallest useful Android client for agents of the wacrm WhatsApp CRM:
login → inbox → thread → plain-text reply. Everything else (templates,
broadcasts, flows, contact editing, media sending, sign-up) stays on the
web app.

## How it talks to the backend

- **Reads** are direct Supabase (PostgREST) queries under the logged-in
  agent's JWT — RLS scopes everything by account membership, exactly
  like the web inbox. No account_id filtering client-side.
- **Realtime** is one app-wide channel on `postgres_changes` for
  `messages` and `conversations` (same events the web consumes). The
  socket carries the user's access token; it is up only while the app
  is foregrounded and logged in.
- **Sends** go through `POST {CRM_ORIGIN}/api/whatsapp/send` with
  `Authorization: Bearer <supabase access token>`. The app never calls
  Meta's Graph API — the Meta token only exists server-side.
- **Inbound media** is loaded from `{CRM_ORIGIN}/api/whatsapp/media/…`
  with the same Bearer header (Coil per-request header).

> **Backend requirement:** the deployed CRM must include the
> `src/middleware.ts` Bearer bypass for `/api/whatsapp/*` (added
> alongside this app). Older deployments 401 every cookieless request
> in middleware before the route's Bearer auth runs — the app then
> treats sends/media as unauthorized and logs the agent out.

## Setup

1. Create `android/local.properties` (never commit it):

   ```properties
   sdk.dir=C\:\\path\\to\\Android\\Sdk
   SUPABASE_URL=https://ycagncvqkdoqntqrpofs.supabase.co
   SUPABASE_ANON_KEY=<NEXT_PUBLIC_SUPABASE_ANON_KEY from the CRM's .env.local>
   CRM_ORIGIN=https://wacrm-blond-eight.vercel.app
   ```

   `sdk.dir` is written automatically if you open `android/` in
   Android Studio. The three backend values become `BuildConfig`
   fields; an empty value produces an app that builds but cannot log
   in, so check here first if login fails instantly.

2. Build a debug APK:

   ```bash
   cd android
   ./gradlew assembleDebug        # Windows: .\gradlew.bat assembleDebug
   # → app/build/outputs/apk/debug/app-debug.apk
   ```

3. Run on an emulator: open `android/` in Android Studio (Ladybug or
   newer — AGP 9.x needs a recent Studio + JDK 17+), pick a device
   image (API 26+), Run ▶. Or from the CLI with an emulator running:

   ```bash
   ./gradlew installDebug
   adb shell am start -n com.wacrm.inbox/.MainActivity
   ```

4. Log in with an existing agent account (accounts are created on the
   web — the app deliberately has no sign-up, because the sign-up
   trigger provisions a whole new CRM account).

## Release APK

```bash
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

The release build is unsigned (no signing config committed). Sign it
with your own keystore, e.g. in Android Studio via
*Build → Generate Signed App Bundle / APK*, or add a `signingConfigs`
block to `app/build.gradle.kts` pointing at a local keystore.

## Project shape

```
app/src/main/java/com/wacrm/inbox/
├── WacrmApp.kt            Application; owns AppContainer
├── MainActivity.kt        Root composable + 3-screen navigation (no nav lib)
├── data/
│   ├── AppContainer.kt    Supabase client, Ktor client, repos, lifecycle-aware realtime
│   ├── Models.kt          @Serializable rows mirroring the CRM schema
│   ├── AuthRepository.kt  Email+password sign-in / sign-out (no sign-up)
│   ├── ChatRepository.kt  Inbox + thread queries, unread reset
│   ├── SendApi.kt         POST /api/whatsapp/send (+401 refresh-retry, 422 window)
│   └── RealtimeManager.kt Single channel: messages INSERT/UPDATE, conversations changes
└── ui/
    ├── login/  ui/inbox/  ui/thread/   one ViewModel per screen
    └── theme/
```

Behaviors worth knowing:

- **Optimistic sends** append a `sending` bubble immediately and
  reconcile with either the POST response or the realtime INSERT,
  whichever lands first (dedupe by id, then by pending text).
- **422** from the send endpoint means Meta's 24-hour window is closed
  → inline banner, draft restored, no retry. **401** → forced session
  refresh + one retry; only a second 401 logs the agent out.
- Network send failures keep the draft in the composer and offer Retry
  via snackbar.
- Non-text messages render labeled placeholder bubbles ("📷 Photo",
  "🎵 Audio", …); images load through the authenticated media proxy.
- On every realtime (re)subscribe the inbox and open thread refetch,
  catching up on events missed while backgrounded.
