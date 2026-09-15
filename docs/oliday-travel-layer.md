# Oliday travel operating layer

Oliday extends WACRM instead of replacing its CRM primitives. Travellers remain `contacts`, WhatsApp history remains in `conversations` and `messages`, sales opportunities remain `deals`, and agents remain account members. The travel tables use the repository's current `account_id` tenancy model and `is_account_member` RLS helpers.

## Database

Apply migrations `041` through `049` in order. They add:

- the Oliday Travel pipeline and stable stage keys;
- versioned travel requirements, RFQs, supplier and traveller quotes, and itineraries;
- suppliers and destination matching;
- callbacks, interactions, tasks, bookings, payment ledgers, financial snapshots, and audit events;
- scoped Realtime publication for lead events, supplier quotes, and callbacks;
- account-scoped RLS on every internal travel table.

Public supplier, callback, and traveller quote pages never use the anonymous Supabase client. Their server routes validate a random opaque token and use the service role only after the token has been hashed and matched. The database stores hashes rather than public token values.

## Qualified-lead webhook

Create a WACRM API key with the `travel_leads:write` scope, then call:

```http
POST /api/travel/leads/qualified
Authorization: Bearer wacrm_live_...
Content-Type: application/json
```

`bot_session_id` is unique within an account. Re-delivery returns the existing lead and does not create another RFQ. Phone identifies the contact only, so separate sessions for the same phone create separate travel leads.

The built-in Oliday WhatsApp assistant also calls this ingestion service directly. A conversation becomes qualified only after it has destination, adults, an explicit child count and one age per child, nights, a date or travel month, 3/4/5-star category, room sharing, meal plan, an explicit vehicle choice, places to cover, and specific requirements. Vehicle menus are constrained by passenger count: hatchback/sedan/SUV for 1–2, sedan/SUV for 3–4, and SUV for larger groups. Completion creates the lead, links it to the WhatsApp conversation, and creates the first supplier RFQ. There is no handoff stage. The conversation id forms the idempotency key, so Meta webhook retries cannot create duplicate leads or RFQs.

## Public links

Set `TRAVEL_PUBLIC_BASE_URL` or `NEXT_PUBLIC_SITE_URL` in production. Oliday sends links under:

- `/supplier/quote/[token]`
- `/trip/callback/[token]`
- `/q/[token]`
- `/trip/itinerary/[token]`

Supplier links expose trip requirements needed to quote and omit traveller identity, phone, conversation, internal pricing, and other suppliers.

## Scheduled maintenance

Schedule `GET /api/travel/cron` with the same `CRON_SECRET` authentication used by the existing automation cron. It processes supplier reminders and RFQ deadlines, task reminders, traveller quote expiry, and booking trip-status changes. Jobs are isolated so one failure does not stop the others.

## Financial rules

Postgres stores money in `numeric` columns. TypeScript treats database money as decimal strings and performs calculations in integer paise using `src/lib/travel/money.ts`. GST configuration, taxable base, markup defaults, response thresholds, supplier limits, and margin warnings are editable under **Settings → Oliday travel**.

Bookings snapshot the accepted quote, requirement, itinerary, supplier quote, and every financial amount. Reporting reads booking snapshots so later supplier or quote edits cannot rewrite historical profit.

## Operational routes

The sidebar exposes Leads, RFQs, Bookings, Suppliers, Itineraries, Follow-ups, Payments, and Reports. The lead detail screen combines the trip brief, recent WhatsApp history, quote comparison, traveller quote versions, itineraries, calls and notes, tasks, financials, and the unified timeline.

The **Itinerary** tab is a versioned day-by-day builder with hotels, meals, transport, activities, inclusions, exclusions, and traveller notes. Agents can save a draft, finalize it, download an Oliday-branded PDF, or send a 30-day secure itinerary link to the linked WhatsApp conversation. The public view and PDF use `public/oliday_logo.png` and `public/oli.png` for branding.
