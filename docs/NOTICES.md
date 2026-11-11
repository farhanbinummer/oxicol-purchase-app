# Email and WhatsApp notices

In-app notices (the bell) always work. Email and WhatsApp are **off until you set them up**. Nothing is sent until then.

## What is sent
**Straight away** (to the person concerned, never to the person who did the action): new R&D request (to the R&D team), task assigned, work submitted for review, work accepted, work sent back, task reopened or cancelled, stage complete, project complete.
**Each weekday morning (about 8:00 India time, not Sundays):** one short message per person with work sent back, work waiting for their review, overdue tasks, tasks due today and tomorrow. Nothing is sent when there is nothing to say.

Each person can switch either kind off under **My Account > Notices**. People with no email/phone (set by an administrator on the Users page) get nothing outside the app.

## Switching it on (Render > Environment)
- Email: the SMTP settings already read by `notify.js` (host, port, user, password, from) and `APP_URL` (the site address, used for links).
- WhatsApp: the WhatsApp Cloud API settings read by `notify.js`. Business-initiated WhatsApp messages need a Meta-approved message template; until you have one, rely on email.
- Morning message: set `JOBS_TOKEN` on Render to a long random secret, then add GitHub repository secrets `APP_URL` and `JOBS_TOKEN` (same value). `.github/workflows/morning-digest.yml` calls the app each morning. Render's free tier sleeps, so the workflow retries while it wakes.

## Checking
- `POST /api/jobs/morning-digest?dry_run=1&force=1` with `Authorization: Bearer <JOBS_TOKEN>` shows what would be sent, sending nothing.
- Administrators can read the last 100 attempts at `GET /api/notices/log` (addresses are masked).
- `NOTIFY_TEST_MODE=1` records messages in the log instead of sending them (used by the tests).

## Not verified
Real SMTP and WhatsApp delivery could not be tested from the development environment. Send yourself a test first.
