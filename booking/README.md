# HARD GYM — free-tier PT booking portal

**Status: CODE BUILT / NOT CONNECTED / NOT OPEN FOR CLIENT BOOKINGS**

Private pilot URL (not linked in the site navigation yet): **https://www.hardgym.com.au/booking/**

The visible page deliberately displays **BOOKINGS ARE BEING SET UP** until `booking/config.js` is populated with a real Supabase project. The page has `noindex,nofollow` until the system has been tested. Do **not** announce this booking URL to clients before the steps below are complete.

## What is already built

- HARD GYM-branded, mobile-friendly client booking page.
- Email/password sign-up, confirmation, login, password reset.
- Client profile (name, optional phone), available sessions, my upcoming bookings, cancellation.
- Three sessions: **1-on-1 PT**, **2-on-1 partner PT**, **private small groups**.
- Partner booking reserves a whole session for the pair; an optional training-partner first name can be noted.
- Group places and accurate capacity, locked atomically in the database to prevent double-bookings.
- Sydney/NSW time zone in all client-facing dates and times.
- Coach-only admin dashboard: add one-time or weekly repeating slots, mark unbooked slots unavailable, view and cancel client bookings, change booking rules.
- Event records for bookings and cancellations; prepared owner and client email notification function.
- Limits configurable by the coach: 12-hour client cancellation cutoff, max 8 upcoming sessions, 42-day booking window (defaults).
- Dedicated standalone route so the existing HARD GYM homepage and consultation forms do not change.

## Services, pricing and constraints (verified November 2026)

- **Website hosting:** existing GitHub Pages (no additional website-hosting fee for these static files).
- **Supabase Free**: $0/month subject to usage limits. Free projects can be **paused after one week of inactivity**, are limited to 500 MB DB, and currently list 50,000 monthly active users. For an important live timetable, arrange backups and monitor pause/availability; consider paid service if reliability requires it.
- **Resend Free**: $0/month with 3,000 transactional emails per month, maximum 100/day as of November 2026. You need to verify a sending domain and configure a sender.
- **No SMS:** SMS generally incurs fees and is not included. Owner messages will be emails.
- This is an independent booking system — it does **not** automatically sync with existing Google Calendar, other apps, existing billing, or client packages.

Sources:
- https://supabase.com/pricing
- https://supabase.com/docs/guides/auth/auth-smtp
- https://supabase.com/docs/guides/database/webhooks
- https://resend.com/pricing
- https://resend.com/changelog/smtp-service

## Step 1 — Create a free Supabase project

1. Register/log in at https://supabase.com/dashboard and create a project for **HARD GYM Bookings** (select a nearby region where available).
2. Go to **SQL Editor**, open `booking/schema.sql` and run it against that project. Only run it once in a new project. Review any SQL errors before continuing.
3. Go to **Project Settings → API Keys** and find the **Project URL** and **publishable/anon key**. These two are the only values intended for browser code. **Never use the service_role key in the public site or send it to a client.**
4. In GitHub, open `booking/config.js` and fill `supabaseUrl` and `supabaseAnonKey` with those public values. You can also do that through a connected Supabase app and GitHub editing tool, if available.

## Step 2 — Set secure authentication + verified emails

Supabase's built-in trial email service cannot be used to send real signup emails to arbitrary customer addresses. **You must connect custom SMTP** before customers can use sign-up/forgot-password.

1. Create a Resend account at https://resend.com and verify a domain you control, e.g. `hardgym.com.au`. Follow the Resend DNS records instructions at your domain registrar. You can use a dedicated sender address such as `bookings@hardgym.com.au` after verifying it.
2. In Supabase **Authentication → SMTP Settings**, enable a custom SMTP provider:
   - host: `smtp.resend.com`
   - port: `465` (SSL) or `587` (STARTTLS)
   - username: `resend`
   - password: your **private Resend API key**
   - sender address: your verified sending address
   - sender name: HARD GYM
3. Supabase **Authentication → URL Configuration**:
   - Site URL: `https://www.hardgym.com.au/booking/`
   - Additional redirect URL: `https://www.hardgym.com.au/booking/`
   - Add `https://hardgym.com.au/booking/` too if your bare domain is active.
4. Keep **Confirm email** enabled. Configure a reasonable email rate limit, bot/abuse protection and password policy in Supabase Auth.
5. Sign up with **your own account first**, verify the email, then run this SQL as the project owner in SQL Editor (use your **actual login email**):
   ```sql
   update public.hg_profiles
     set role='admin'
     where email='your-actual-admin-email@domain.com';
   ```
   Refresh/login again to see **COACH DASHBOARD**. Never place this promotion SQL into client-side code.

## Step 3 — Turn on booking notification emails

Prepared function: `booking/supabase/functions/booking-notify/index.ts`.

1. Create/deploy a Supabase Edge Function named **booking-notify** using its Dashboard editor or CLI. Use the code from that file.
2. In the function settings, set **verify_jwt = false** for the database-to-function webhook only; the function **rejects any request without a matching secret header** `x-hg-webhook-key`. Never open this endpoint without configuring the secret.
3. In Supabase Edge Function Secrets, set:
   - `RESEND_API_KEY` = a Resend API key (secret)
   - `BOOKING_FROM_EMAIL` = `HARD GYM <bookings@hardgym.com.au>` (must be a verified sender)
   - `BOOKING_OWNER_EMAIL` = the email where the trainer receives booking/cancellation alerts, e.g. `info@hardgym.com.au`
   - `BOOKING_WEBHOOK_SECRET` = a long, random secret string (same exact value as the webhook header)
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are normally injected automatically into Supabase functions. If your project uses a newer secret-key model, adjust the function's server-only secret usage in the dashboard; **never** copy a secret key into the GitHub Pages files.
4. Supabase **Database → Webhooks → Create**:
   - Name: `hg-booking-notifications`
   - Table: `public.hg_booking_events`
   - Event: **INSERT only**
   - Method: **POST**
   - Destination: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/booking-notify`
   - Header: `Content-Type: application/json`
   - Header: `x-hg-webhook-key: THE-SAME-BOOKING_WEBHOOK_SECRET`
5. Perform a real test with a new client login: create a slot as admin, book as client, ensure **one owner confirmation** and **one client confirmation** arrive. Cancel and verify both cancellation emails. Confirm the event entries are marked delivered in Supabase. Inspect function invocation logs and webhook logs if anything fails.

**Important:** Booking creation doesn't depend on email provider availability; if mail sending fails, the booking can still be saved. The `hg_booking_events` table retains undelivered event records, so check the dashboard for errors. Delivery is not guaranteed until configuration and testing pass.

## Step 4 — Test before making the booking link public

Do not skip:

- [ ] Owner can sign in and sees only the admin dashboard (regular accounts never receive admin permissions).
- [ ] An unverified account cannot book; forgotten password email works.
- [ ] A client sees **only their own** bookings/profile, not other people's email/phone numbers.
- [ ] Two different client accounts trying to book the same last slot: only one succeeds.
- [ ] Group capacity reduces accurately as clients book.
- [ ] 2-on-1 reserves the paired session for the whole pair.
- [ ] Block an open time; it disappears from availability.
- [ ] A booked session cannot be blocked until existing bookings are cancelled.
- [ ] Check Sydney daylight saving dates and time conversions.
- [ ] The booking and cancellation email arrives to the coach and the client.
- [ ] Test on iPhone, iPad, desktop Safari/Chrome and slow mobile connections.
- [ ] Set appropriate privacy information, contact details, retention and security procedures for real client records. Obtain informed consent for emails; don't collect medical histories in the booking form.
- [ ] Export/back up the booking data; monitor Supabase Free project pause/availability.
- [ ] Add the **CLIENT BOOKINGS** navigation link to the main HARD GYM website only after passing all the above tests.

### Suggested future additions (not in this version)

Automated session reminders, waitlists, package credits/attendance, coach-specific logins, calendar integration and recurring-client bookings. SMS notifications and payment processing may have additional costs.

## Security

- Supabase row-level security prevents clients reading other users' private records. Stored booking capacity is protected using a server-side row lock and RPC transaction.
- Clients cannot change their `role` to admin. Only the database/project owner can promote a coach through SQL.
- API keys with privileged database access and Resend credentials **must stay server-side**. The public Supabase anon/publishable key relies on enforced RLS.
- The private Edge Function webhook requires a secret header. It does not accept requests from arbitrary browser scripts.
- Don't treat this starter as production-ready until Supabase, SMTP, webhook, and real user roles have been connected and tested.

## Code files

- `booking/index.html` — responsive client/admin interface (not linked publicly)
- `booking/styles.css` — HARD GYM styling
- `booking/app.js` — account, slots, bookings and admin client logic
- `booking/config.js` — public Supabase project URL and publishable key placeholders
- `booking/schema.sql` — database, protected functions, policies, events
- `booking/supabase/functions/booking-notify/index.ts` — email notification Edge Function

The existing homepage, forms, navigation and service pages have not been changed for this private test build.
