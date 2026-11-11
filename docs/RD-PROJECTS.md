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

## Checklist results and stage reports

Ticking a checklist item records **what was found**, not only that it was done.

* **A result is needed to tick an item.** Every item asks for it except "Obtain QC sign-off" and "Record handover acknowledgement", whose record is the approval. Up to 2000 characters. The result is saved with who ticked the item and when.
* **Unticking keeps the result** so no work is lost; ticking again does not need retyping. A result can be edited while the stage is open.
* **A completed stage is locked.** Changing a result means reopening the stage (a reason is required and is kept in the history).
* **Results are confidential, like lab notes.** Only people with `field.rd_technical` (R&D by default) receive the text. Everyone else sees "A result has been recorded. It is confidential to R&D." and who recorded it. The audit log says an item was ticked or a result was saved, never what the result said.
* **Items ticked before this existed** show "No result recorded (ticked before results were kept)". They are not blocked and completed stages are untouched (migration `012_rd_checklist_results` only adds two columns).
* **Reports.** `project-report.html?id=N` is a printable report of every stage (item, result, who, when, plus the QC, customer and handover sign-offs); add `&stage=N` for one stage. Completed stages have a "Report" link in Milestones. The report uses the project's own visibility and confidentiality rules; it adds no new API.

## Tasks, "My Day" and task results

* **A task is completed with a result.** "Complete task" asks "What was the result?" (at least 10 and at most 2000 characters). The status boxes, the Board and the API's status route no longer accept Done on their own. The result is saved with who completed the task and when.
* **Who may complete a task:** the person responsible, or R&D with edit rights. A view-only person (for example the Manager) cannot.
* **Finished tasks are locked.** They change only by being **reopened**, which needs edit rights and a reason. The earlier result stays in `rd_task_history`.
* **Results are visible to anyone who can open the project** (a task result is not lab content, unlike checklist results). The audit log says a task was completed or reopened, never what the result said.
* **New tasks need a responsible person and a due date**, so every task lands on someone's day. Tasks created before this keep working, including unclaimed team tasks.
* **My Day** (`my-day.html`, `GET /api/rd/my-day`): the person's open tasks in Overdue, Today, Tomorrow and This week and later; the stages they own with checklist items left; tasks they assigned to other people ("Waiting on others"); and what was finished in the last 7 days with its result. It uses the same project visibility rules as the project list. Tasks completed before results existed show "No result recorded".
* Migration `013_rd_task_results` adds `result` and `completed_by` to `rd_tasks` and creates `rd_task_history`. Nothing is dropped.

## Splitting a big stage: assigned work, trainees and review

* **The stage owner assigns part of a stage.** "Assign part of this stage" (or "Assign" beside one checklist item) creates a task tied to the stage and, optionally, to one checklist item of that stage. It needs a responsible person and a due date. The person is added to the project team automatically so they can open it.
* **The stage shows its assigned work:** "3 of 5 done, 1 waiting for review, 1 overdue" and the people involved.
* **Review.** A task that needs review is *handed in* by the person doing it ("Submit for review"); it becomes **In review** and is locked. Someone else with edit rights (the owner) **accepts** it, or **sends it back** with a comment. The person who did the work can never accept their own work. Review is always on for a trainee; for anyone else the person assigning chooses. The whole conversation (submitted, sent back, accepted) is kept in `rd_task_history`.
* **Use the result.** When ticking a checklist item the owner can copy the result of a finished task tied to that item and edit it.
* **A stage cannot be completed while assigned work is open** (To do, In progress, Blocked or In review). Finish it or **cancel it with a reason** (the reason stays on the record). A cancelled task can be reopened.
* **R&D Trainee role.** Holds only `rd.view`: sees the projects they are on and their own tasks, can complete their own tasks, and gets no edit rights, no stage completion, no confidential lab content and no ability to assign work. It uses the R&D workspace. Create trainees under Administration > Users.
* **Reports** list the work assigned within each stage, who did it, the result, and who checked it.
* Migration `014_rd_stage_work_review` adds the task columns, the two new statuses (In review, Cancelled), the trainee role and its grant. Nothing is dropped.

## Result forms: the owner decides what comes back

* **When assigning a task** the owner chooses "What should they bring back?": free text (as before), a **ready-made form** (viscosity, solids, pH, appearance, raw material sample, test result pass or fail, plant trial), **a checklist of steps**, or **a custom form** with their own fields. The owner can change, remove or add fields, mark them required, and give a number an **expected range**.
* **The person doing the task gets exactly that form** when they complete or submit it: dropdowns, dates, numbers with units, yes or no, and required fields. They cannot hand in an incomplete form. Instructions written by the owner are shown with the task on My Day and in the dialog.
* **Answers are checked by the server** against the form the task was assigned with (required, numbers, units, choices, dates, lengths). The page is not trusted.
* **A number outside its expected range is flagged, not blocked.** The reviewer sees "98 KU - Above range" next to the answer.
* **The form is fixed when the task is assigned.** The task keeps its own copy (`rd_tasks.result_schema`), so editing a starter form later never changes work already assigned, and the form cannot be swapped afterwards.
* **Answers are stored as structured data** (`result_data`) and as a readable summary in the task's `result` text, so My Day, the Board, "use the result from a finished task", and the audit rules work unchanged. The audit log never contains the answers.
* **Reviewers and reports** see a labelled table instead of a paragraph. Send back clears the answers (the summary stays in the history).
* **A trainee's home page** shows only their own work: no "Projects I lead" or "Requests to assess".
* The starter forms are defined in code (`FORM_TEMPLATES` in `rd-logic.js`). There is no screen yet for administrators to edit the starter library. Migration `015_rd_task_result_forms` adds the two columns.

## Team performance (KPIs)

* **Where:** administrators and the Manager open **Team Performance** (Reports in the menu, and a "Team performance" section on their home page). Every person opens **My Performance** for their own numbers only. Permission `kpi.view_all` (Administration > Permissions) controls who sees everyone: Manager by default, administrators always.
* **Measured from records the app already keeps**, for a chosen period (last 30 days, this month, last month, last 90 days, or any dates up to a year):
  * **Tasks done** and **on time** (finished on or before the due date, out of tasks that had a due date), with the counts, and how late the late ones were. Only tasks the person completed themselves count; a task someone else closed for them does not.
  * **Overdue now** (to do, in progress or blocked and past due; work waiting for review is not late) and **open now** (workload).
  * **Right first time:** work accepted without ever being sent back, out of work accepted in the period.
  * **Stages on time:** stages the person owns (or leads when no owner is named) finished on or before the planned date, and the average delay.
  * **Review speed:** for reviewers, average days from hand-in to accepted or sent back.
* **Colour bands** (always with a word and a symbol, never colour alone): green from 90%, amber from 70%, below that "Below target"; overdue tasks green at none, amber up to 2, then below target. An administrator can change these under **Targets** (audited).
* **No score and no ranking.** People are listed alphabetically; percentages always show the counts behind them, with a "few items" warning when there are too few to mean much. A short "How these numbers are measured" explanation sits on both pages. Numbers do not show how hard the work was.
* **Detail per person:** a six-month on-time chart (with a text list) and their tasks. **Export spreadsheet** downloads the table as CSV.
* **Limits:** only work recorded in the app counts; older tasks without due dates or results cannot. Only R&D is measured so far (Purchase, Stores, QC and Accounts are not yet). Migration `017_team_performance` adds the `kpi_targets` table and grants `kpi.view_all` to the Manager.

## Permission matrix (defaults)

An administrator holds every key. A "-" means the key is not granted. Granted keys can be changed in Administration > Permissions.

| Role | rd.view | rd.view_all | rd.create | rd.edit | rd.stage | field.rd_technical | Approval keys |
|---|---|---|---|---|---|---|---|
| R&D | yes | yes | - | yes | yes | yes | - |
| Manager | yes | yes | yes | - | - | - | - |
| Branch / requester | yes (own) | - | - | - | - | - | - |
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
2. **Who may start R&D requests.** Default is Manager only (and administrators); R&D and Branch cannot raise requests. Purchase, QC, Stores, Production and Accounts can view only projects they are involved in.
3. **Who sees confidential technical content.** Only R&D by default. QC and Production see none of it until given `field.rd_technical`.
4. **Stage cool-down.** 10 seconds between completions on one project. Change with `RD_STAGE_COOLDOWN_SECONDS`.
5. **Hand-offs.** Sample or material requirements to Purchase, test requests to QC, and plant-trial hand-over to Production are not built. They will create requests in those departments' own queues; **no experimental formula will be published into a production recipe without an authorised release**.
6. **Attachments** need a decision on where files are stored (the app has none).
7. **E-mail and messaging** stay disabled; the Inbox (not built) will show in-app items only.
8. Fields on the request form record what the requester states. The application does not certify regulatory or safety compliance.
