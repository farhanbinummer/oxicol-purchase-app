# Oxicol Purchase Management System - visual theme

A presentation-only redesign: a navy sidebar, light neutral pages, white surfaces and teal actions, with a matching dark mode.
Business rules, calculations, permissions, database structure and API behaviour are unchanged: no file under `backend/` or `database/` was touched.

Screenshots of the main screens are in `docs/screenshots/` (light, dark, tablet and phone).

## Where the theme lives

| File | What it holds |
|---|---|
| `frontend/styles.css` | Every colour, size and component style. Section 1 is the token set; the rest uses only those tokens. |
| `frontend/theme-init.js` | Sets light/dark from `<head>` before the page paints, so a dark-mode user never sees a bright flash. |
| `frontend/common.js` | The app shell (sidebar, header, menus), the shared page header and breadcrumbs, status badges, and small accessibility helpers. |

To change a colour, change its token in `styles.css`; do not restyle a page on its own.

## Tokens

Light (`:root`) and dark (`:root[data-theme="dark"]`) share the same names.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | #F5F7FA | #0F151D | page background |
| `--surface` / `--surface-2` | #FFFFFF / #F8FAFC | #17202B / #1C2735 | cards, tables, forms / table headers, tiles |
| `--sidebar` / `--sidebar-hover` | #142235 / #20334C | #0A1118 / #17222F | navigation |
| `--primary` / `--primary-hover` | #0F766E / #115E59 | #0F766E / #138A80 | buttons and selected states (white text on them) |
| `--accent` | #0F766E | #2DD4BF | teal used as text, links and outlines |
| `--text` / `--text-2` | #172033 / #526174 | #E7ECF3 / #A5B2C3 | main / supporting text |
| `--border` | #DCE3EB | #2B3848 | borders |
| `--success` `--warn` `--danger` `--info` | #15803D #B45309 #B91C1C #1D4ED8 | #4ADE80 #FBBF24 #F87171 #7DB2FF | status text and icons, each with a pale `-bg` |

Spacing scale `--s1` to `--s7` = 4, 8, 12, 16, 24, 32, 48 px. Controls and buttons are 40 px high (44 px on phones), radius 8 px; cards and panels use 12 px.
Font: Inter if installed, otherwise the system sans-serif (no external font is downloaded). Money and quantities use tabular numerals.

## Reusable pieces

Page header and breadcrumbs (built automatically from each page's title) · buttons (primary, `.oxi-btn-secondary`, `.oxi-danger`, loading state) ·
inputs, selects, textareas (required marker, invalid, disabled) · cards and metric cards · tables (sticky header, right-aligned amounts, totals summary) ·
filter toolbar and chips · status badges (`badge-good/warn/bad/info/pending/neutral/inactive`, each with a symbol and a word) ·
alerts (`#message`, `.oxi-alert`) · toast · dialog · loading skeleton and empty state · detail tiles · login card.

## What changed for users

- Sidebar with visible labels beside icons, grouped by task, a clear active marker, and a collapse button. Collapsed, it shows icons with a floating label; on phones it is a drawer. Menu entries still come from the server's permission list.
- Header: search, notifications, a "New" menu and the account menu. Every page has breadcrumbs, a title with a short description, and its main action as a button on the right.
- Dashboard: compact action cards, one highlight and a row of metrics. The numbers and periods are the real ones; nothing was added.
- Lists, forms and detail pages share one table, filter and form design. Long forms keep their Save row in view. Totals read as a summary. Delete/Reject/Remove buttons are outlined in red and kept apart from routine actions (their confirmations are unchanged).
- Status labels use friendly words and a colour class; the stored values and API are unchanged. `invoice_matched` now shows as good (it was grey), and `created`, `in_transit`, `uploaded` show as information rather than warning.
- Login: branded card, labels above fields, and a Show/Hide password button. No password-recovery link was added, because there is no recovery feature.
- Dark mode: the existing toggle (bottom of the sidebar) and saved preference are kept.
- Print: a record always prints black on white with the letterhead, whichever theme is on screen.

## Fixed along the way

- Initials in the account button were wrong for names with spaces (a missing backslash in a pattern).
- The material-planning page broke when its breadcrumb link was moved; the header builder now keeps every original element (and never drops one with an `id`).
- Printing from dark mode produced near-white headings on white paper.
- On phones the stacked page header reserved a 320 px empty gap.

## Verification

Run on the final code with the local database:

- All 27 pages, at 360, 768, 1024 and 1440 px, in light and dark: no horizontal overflow, no text below the WCAG contrast minimum (4.5:1, or 3:1 for large text), no blank pages. The checker was confirmed to detect a deliberately bad page.
- Every component state (all badge types, alerts, disabled/invalid fields, danger and loading buttons, totals) on a temporary component sheet, both themes.
- Every `id` present in each page's original HTML is still present after the shell builds, and no page throws a script error.
- Accessible names on every link, button and field; one main landmark per page; skip link; visible focus rings; Escape closes menus; reduced-motion preference respected.
- Keyboard: skip link on first Tab, focus ring on sidebar links, collapsed menu with tooltips.
- Print layout checked in dark mode.
- 33 automated backend tests pass (the backend is unchanged).

## Limitations

- The installable-app icons (`frontend/icons/`) are still the old purple ring, and any Android APK built earlier still carries them. Only the theme and splash colours were updated.
- Charts: the app has none, so nothing was themed for them.
- Dialogs: the app uses the browser's own confirm/prompt boxes, which follow the operating system, not the app theme. A `dialog` style exists for when they are replaced.
- Phone and tablet layouts were checked with the built-in browser's emulation and a headless browser, not on physical devices.
- Page titles that were long free text (for example a request number) can wrap onto two lines on a phone.
