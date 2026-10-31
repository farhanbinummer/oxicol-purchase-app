# R&D Projects module

Part of the existing Oxicol application: same sign-in, same database, same permissions, same front end. Nothing here runs as a separate site.

## What is built (stages 1 to 5 of the plan)

| Stage | What | Where |
|---|---|---|
| 1 | Inspection of the existing app, shared layout and workspaces | `docs/WORKSPACES.md`, `frontend/common.js` |
| 2 | R&D data structures, atomic numbering, permissions, R&D role and workspace | `backend/migrate.js` (009, 010), `backend/rd-logic.js`, `backend/routes/rd.js` |
| 3 | R&D request form (draft and submit) | `frontend/project-new.html` |
| 4 | Project directory and project workspace with **Overview** and **List** | `frontend/projects.html`, `frontend/project.html` |
| 5 | Milestones, scheduling, stage completion and reopening, approvals | `frontend/project.html`, `backend/routes/rd.js` |

**Not built yet, and therefore not in any menu or tab:** task detail side panel, My Tasks, Inbox, Board, Timeline, Calendar, department hand-offs (Purchase / QC / Production records), file attachments (the application has no file storage yet), favourites reordering. Navigation shows only what works.

## Screenshots

`docs/screenshots/rd/`: Home with the management R&D band, Project list, Project overview (next step), milestones, and the List tab with tasks. Board and My Tasks have no screenshot because they are not built.

## Rules that the server enforces (not only the page)

* **Project number** `OXRD` + monthly serial (at least two digits, three or more after 99) + `MM` + `YY`, for example `OXRD011026`, `OXRD1001226`. Allocated inside the submitting transaction from a per-month counter row, so simultaneous submissions get different, sequential numbers. A unique constraint is the backstop. The internal id is separate. Drafts have no number.
* **Visibility:** a draft is seen only by its creator and administrators. A submitted project is opened by people holding `rd.view_all`, or by people holding `rd.view` who are the requester, lead or a team member. A project the person may not open answers "not found". Counts, lists and dashboards use the same SQL clause, so a count never includes a project the list would hide.
* **Confidential content** (technical approach, risks, lab notes) needs `field.rd_technical`. Without it the server leaves these out, refuses writes to them, and the audit trail never stores their text.
* **Stage completion:** only the current stage (first one not complete); every checklist item done; any required approval recorded as approved (stage 4 QC sign-off, stage 6 customer evidence, stage 8 production handover acknowledgement); date not in the future and not before the previous stage; the project must not be On Hold, Rejected or Completed; a confirmation flag must be sent; the stage version must match; the update is conditional (`completed_at IS NULL`) inside a row-locked transaction; and a short cool-down (10 seconds, `RD_STAGE_COOLDOWN_SECONDS`) stops a burst from completing several stages. Rapid clicks complete one stage, not several.
* **Reopening** requires a reason, keeps the completion in `rd_stage_history`, and does not clear later stages: it flags them "needs review". The project cannot be marked completed while a stage is flagged.
* **Scheduling:** all durations are calendar days (labelled). Defaults 7 / 5 / 21 / 14 / 3 / 14 / 7 / 5; stage 3 follows the estimated trial duration when set. "Fill in empty planned dates" only fills stages with no date. A changed trial duration offers a preview of new dates; nothing is rewritten until the person applies them. Conflicts (a stage dated before an earlier one, or a finish after the target launch date) are shown.
* **Dates** are plain `YYYY-MM-DD` strings end to end and shown as DD-MM-YYYY; "today" is Asia/Kolkata. No time-zone conversion is applied to a business date.
* **Concurrent edits:** projects, stages and tasks carry a `version`. A save with an old version is refused with a message and a "Reload" action; the person's typed text stays on screen.
* **Status:** `On Hold` means paused. "Active" is defined on screen as: Received, Under Review, Approved, In Lab Trials, Sample Sent, Plant Trial. Completed and Rejected are closed. Completing a project is only done with "Mark Project Completed" once all eight stages are done.
* **Tasks:** one accountable assignee; a task nobody has claimed is shown as "Unclaimed (team)". A task being done never completes a stage or records an approval.
* **Approvals** are append-only records made under the signed-in person's own name. Submitting a request is recorded as "submitted" and is not a management authorisation. Customer approval records the customer's representative, the evidence, and the internal person who recorded it.

## Permission matrix (defaults)

An administrator holds every key. A "-" means the key is not granted. Granted keys can be changed in Administration > Permissions.

| Role | rd.view | rd.view_all | rd.create | rd.edit | rd.stage | field.rd_technical | Approval keys |
|---|---|---|---|---|---|---|---|
| R&D | yes | yes | yes | yes | yes | yes | - |
| Manager | yes | yes | yes | - | - | - | - |
| Branch / requester | yes (own) | - | yes | - | - | - | - |
| Production | yes (own) | - | - | - | - | - | - |
| Purchase | yes (own) | - | - | - | - | - | - |
| QC | yes (own) | - | - | - | - | - | - |
| Stores | yes (own) | - | - | - | - | - | - |
| Accounts | yes (own) | - | - | - | - | - | - |

"own" means projects the person requested, leads or is a team member of. **Approval keys** (`rd.approve_head`, `rd.approve_mgmt`, `rd.qc_signoff`, `rd.handover_ack`) are granted to **no role** by default: see the decisions below. Workspace choice is presentation only; choosing a workspace never grants a permission.

The global search does not index R&D projects, so no R&D text can appear in search results, counts or notifications for people who may not open the project.

## Existing project OXRD011026 "Under chassis coating"

Nothing was invented or imported automatically. `backend/scripts/import-oxrd011026.js` prepares a **reviewable** import:

```
node scripts/import-oxrd011026.js                  dry run: prints exactly what would be created
node scripts/import-oxrd011026.js --apply          creates it once; a second run does nothing
```

It fills only what was reported (title, type, High priority, requester Saifudheen, R&D Internal, brand HERAKLEON, Underchassis / Antirust Coating, solvent-based, the description, Schutz gun / spray, primed or bare metal, detailing shops, benchmarks 3M / Autochrome / PPG), sets the launch date to **To be confirmed** (the old 01-11-2020 date is not used), creates the eight stages **not started**, and creates **no approvals**. It stops with a message if the number is already used by another project, so it can never duplicate or overwrite.

The reported completion of all eight stages on the same day is **not imported**. If the owner confirms it, run with `--apply --stages-completed-on=YYYY-MM-DD --owner-confirmed`; both flags are required. Even then no approval is created, so the QC sign-off, customer evidence and handover acknowledgement remain "Not recorded" until the people who gave them record them.

## Verification (local database, real server)

* `npm run test:all`: unit tests, R&D rule tests, 17 R&D integration tests plus the import test, workspace tests and the existing purchasing integration tests. Results are in the hand-over message.
* Covered: unique numbering under simultaneous submissions and above 99 a month; role, branch scope and confidential-field restrictions; stage-owner fallback to the lead and explicit owners kept; auto-plan keeps entered dates; no date shifts; one completion from rapid or simultaneous clicks; the cool-down; reopen keeps history and flags later stages; completion blocked without checklist or approval; directory, dashboard and sidebar counts agree; failed and stale updates leave data unchanged; existing purchase order and branch request calls still work.
* Browser checks (light and dark, 360 px to 1280 px): no horizontal page overflow, no text under 4.5:1 contrast on the three new pages, every control has an accessible name, dialogs return focus, the stale-edit banner appears and reloads.

## Business decisions still needed (nothing was guessed)

1. **Who may record each approval.** R&D Head, Management, QC sign-off and Production acknowledgement are granted to nobody. Until an administrator ticks the key for a role (Administration > Permissions) those approvals cannot be recorded and the stages that need them cannot be completed.
2. **Who may start R&D requests.** Default is R&D, Manager and Branch. Purchase, QC, Stores, Production and Accounts can view only projects they are involved in.
3. **Who sees confidential technical content.** Only R&D by default. QC and Production see none of it until given `field.rd_technical`.
4. **Stage cool-down.** 10 seconds between completions on one project. Change with `RD_STAGE_COOLDOWN_SECONDS`.
5. **Hand-offs.** Sample or material requirements to Purchase, test requests to QC, and plant-trial hand-over to Production are not built. They will create requests in those departments' own queues; **no experimental formula will be published into a production recipe without an authorised release**.
6. **Attachments** need a decision on where files are stored (the app has none).
7. **E-mail and messaging** stay disabled; the Inbox (not built) will show in-app items only.
8. Fields on the request form record what the requester states. The application does not certify regulatory or safety compliance.
