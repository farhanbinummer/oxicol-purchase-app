# Email and WhatsApp notices

In-app notices (the bell) always work. Email and WhatsApp are **off until you set them up**. Nothing is sent until then.

## What is sent
**Straight away** (to the person concerned, never to the person who did the action): new R&D request (to the R&D team), task assigned, work submitted for review, work accepted, work sent back, task reopened or cancelled, stage complete, project complete.
**Each weekday morning (about 8:00 India time, not Sundays):** one short message per person with work sent back, work waiting for their review, overdue tasks, tasks due today and tomorrow. Nothing is sent when there is nothing to say.

Each person can switch either kind off under **My Account > Notices**. People with no email/phone (set by an administrator on the Users page) get nothing outside the app.

## Switching it on (Render > Environment)
- Email (recommended on Render's free plan, which blocks SMTP): create a free Brevo account, verify a sender address, make an API key, then set `BREVO_API_KEY` and `BREVO_FROM` (the verified address; optional `BREVO_FROM_NAME`). These take priority over SMTP.
- Email by SMTP (only where outgoing SMTP is allowed): the SMTP settings already read by `notify.js` (host, port, user, password, from) and `APP_URL` (the site address, used for links).
- WhatsApp: the WhatsApp Cloud API settings read by `notify.js`. Business-initiated WhatsApp messages need a Meta-approved message template; until you have one, rely on email.
- Morning message: set `JOBS_TOKEN` on Render to a long random secret, then add GitHub repository secrets `APP_URL` and `JOBS_TOKEN` (same value). `.github/workflows/morning-digest.yml` calls the app each morning. Render's free tier sleeps, so the workflow retries while it wakes.

## Checking
- `POST /api/jobs/morning-digest?dry_run=1&force=1` with `Authorization: Bearer <JOBS_TOKEN>` shows what would be sent, sending nothing.
- Administrators can read the last 100 attempts at `GET /api/notices/log` (addresses are masked).
- `NOTIFY_TEST_MODE=1` records messages in the log instead of sending them (used by the tests).

## Not verified
Real SMTP and WhatsApp delivery could not be tested from the development environment. Send yourself a test first.

## The morning message and its timing

The app only sends the morning message between **06:00 and 11:00 India time**, never on Sunday, and once a day. A call that arrives outside that window is skipped and does not use up the day, so nobody gets a "good morning" at 4 pm. (`force=1` and `dry_run=1` on the job URL bypass the window, for testing.)

**Why it can still be late.** GitHub's free scheduled timer is only approximate and is often hours late. `.github/workflows/morning-digest.yml` therefore asks several times (07:00, 07:30, 08:00, 08:30, 09:00 and 10:00 India time, Monday to Saturday); the first call that really runs inside the window sends the message and the rest find it already sent. If GitHub is later than 11:00 for all of them, there is no message that day, on purpose.

**For an exact time, use an outside timer** (free, for example cron-job.org). Render's free site sleeps, so use two jobs:
1. 07:55 India time, Monday to Saturday: `GET https://oxicol-purchase-app.onrender.com/api/health` (this wakes the site).
2. 08:00 India time, Monday to Saturday: `POST https://oxicol-purchase-app.onrender.com/api/jobs/morning-digest` with the header `Authorization: Bearer <your JOBS_TOKEN>`.
Set the timer's time zone to Asia/Kolkata. Keep the GitHub timer as well: whichever runs first inside the window sends, the other finds it already sent.
