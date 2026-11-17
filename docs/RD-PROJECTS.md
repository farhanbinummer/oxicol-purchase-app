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

| Role | rd.view | rd.view_all | rd.create | rd.edit | rd.stage | rd.trial_view | rd.trial_edit | rd.trial_cost | rd.cover_approve | field.rd_technical | Approval keys |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R&D | yes | yes | - | yes | yes | yes | yes | - | - | yes | - |
| Manager | yes | yes | yes | - | - | yes | - | yes | yes | - | - |
| Branch / requester | yes (own) | - | - | - | - | - | - | - | - | - | - |
| Production | yes (own) | - | - | - | - | - | - | - | - | - | - |
| Purchase | yes (own) | - | - | - | - | - | - | - | - | - | - |
| QC | yes (own) | - | - | - | - | yes | yes | - | - | yes | - |
| Stores | yes (own) | - | - | - | - | - | - | - | - | - | - |
| Accounts | yes (own) | - | - | - | - | - | - | - | - | - | - |

"own" means projects the person requested, leads or is a team member of. **Approval keys** (`rd.approve_head`, `rd.approve_mgmt`, `rd.qc_signoff`, `rd.handover_ack`) are granted to **no role** by default: see the decisions below. Workspace choice is presentation only; choosing a workspace never grants a permission.

The global search does not index R&D projects, so no R&D text can appear in search results, counts or notifications for people who may not open the project.

## Lab trials (structured trial records)

Stage 2 (First Lab Batch) and stage 3 (Lab Trials & Optimisation) used to have only free-text lab notes and tick boxes. Each trial can now be recorded as data. Migrations `020_rd_trials`, `021_rd_trial_fields_and_files` and `022_rd_task_trial_link` add `rd_trials`, `rd_trial_results` and the append-only `rd_trial_corrections`.

**What a trial holds:** trial number (T1, T2, ... per project, allocated inside the insert transaction while the project row is locked, so simultaneous saves cannot duplicate; unique on project and number), stage (2 or 3), date (not in the future), who recorded it (taken from the signed-in user, never typed), formula or version used, what changed from the previous trial, batch size, observations, an outcome (Rejected, Needs another trial, Preferred formula), an optional raw-material cost per kg, and one result (Pass, Fail, Not tested) with a measured value for each of the project's performance requirements. Requirements left out count as "Not tested".

**Rules the server enforces**
* **Trials are never deleted.** A correction needs a reason (at least 5 characters) and the current version; it edits the trial in one transaction and writes a row to `rd_trial_corrections` holding the old and new values. A stale version answers the usual "someone else changed this" message (HTTP 409). A correction that changes nothing is refused.
* **Confidential content** (formula, what changed, observations, measured values) needs `field.rd_technical`: without it the server omits it from every response (including the old values in correction history, and the reasons), and refuses writes. Because the formula is required, recording or correcting a trial needs `field.rd_technical`. The audit trail and the activity feed never contain this text: they record that a trial was added or corrected, which fields changed, and the non-confidential facts (stage, date, outcome).
* **Cost per kg** needs `field.prices`: without it the value is omitted from responses and writes to it are refused. **R&D does not enter costs.** The Manager holds the separate `rd.trial_cost` key and passes it to another department, for example Accounts: an administrator gives that department `rd.trial_view` and `rd.trial_cost` (Roles & Permissions) and puts its people on the project (assigning them a task does this). They then see each trial's structure and cost, can enter or change the cost per kg from the trial's detail (a change needs a reason, the earlier cost stays in the history), and never see a formula, observations or measured values, and cannot record trials. The audit trail records that a cost was set, never the amount.
* **Who:** `rd.trial_view` lets a person see trials; `rd.trial_edit` lets them add and correct; `rd.trial_cost` lets them enter or change the cost per kg (and also needs price access). Both also require being able to open the project (a project you cannot open answers "not found"). Defaults: R&D and QC record and correct trials (QC also holds `field.rd_technical`, because a trial's formula is technical content, and QC only reaches projects it is a member of, never every project); R&D, QC and Manager see them; the Manager holds `rd.trial_cost`. Administrators hold every key. Migration 023 added the QC and Manager grants and never removes anything.
* **Closed or paused projects:** no trial can be added or corrected on a project that is On Hold, Rejected, Completed or still a draft. Existing trials can still be read.
* **Preferred formula** only records the outcome. It completes no stage, ticks no checklist item and records no approval. At most one trial per project is Preferred (also enforced by a unique index): marking a trial preferred sets the earlier one back to "Needs another trial" through a correction row stating why, in the same transaction.
* **Extra fields ("Add a field"):** besides the fixed fields, a person can add up to 15 fields of their own to a trial (a name and a value, for example "Pot life: 4 h"). A new trial starts with the field names of the previous trial (empty values), so nothing is retyped; any field can be renamed or removed. They are confidential like observations, are corrected and kept in the correction history like every other field, and the audit trail never holds their names or values. The fixed fields other than date, stage, formula and outcome can simply be left empty.
* **Photographs and files:** JPEG, PNG or PDF, up to 5 MB each, 10 per trial and 60 MB per project, stored in the database (the hosting disk is not permanent). The file's own first bytes decide what it is (an HTML or SVG file renamed to .jpg is refused); names are cleaned; files are served with `nosniff`, a locked-down content policy, and PDFs always as a download. Photographs are shrunk in the browser (longest side 1800 px) before they are sent. They are confidential (need `field.rd_technical`; others see only "N files attached"), can be added or removed only by people with `rd.trial_edit` and only while the project is open, and "Remove" needs a reason and keeps the file in the database. The audit trail and activity feed record that a file was added or removed, never its name.
* **Overview and dashboard:** the project Overview has a "Lab trials" card (count, latest result against the one before, last trial date, preferred formula; the formula's name only with technical access). The R&D to-do list shows projects you own whose current stage is a lab stage (2 or 3) with no trial recorded, or none for 14 days.
* **Soft stage warning:** stages 2 and 3 show a warning (in "Attention needed" and in the complete-stage dialog) when no lab trial is recorded for that stage. It never blocks: if the stage is completed anyway, the history and audit say "no lab trial was recorded".
* **Task link:** when a task is assigned in stage 2 or 3, "This task produces a lab trial" can be ticked (at creation only). The person sees it in My Day with a "Record trial" button; in the Add trial dialog they choose the task, and saving the trial links the two and completes the task by the usual rules (handed in for review where review is required; the result is a plain sentence such as "Lab trial T3 recorded: Needs another trial, 3 of 6 requirements pass", never confidential text). A task that asks for its own result form is only linked and stays open. Only the person responsible (or the person covering for them) may use their task.
* **Notices:** when a trial is recorded, the project lead and the stage owner are told (bell not used; email/WhatsApp when switched on); when a trial is marked preferred, the lead, the requester and the stage owner are told, in words that say it completes no stage and gives no approval. Notices never carry the formula, observations or values. The morning message lists lab projects (that you own) with no trial recorded or none for 14 days.
* **Later stages:** from stage 4 onward the project's "next step" card shows the preferred formula chosen in the lab (the formula name only with technical access) with a link to the trial.
* **Printed report:** the project report (and the stage 2 and stage 3 reports) end with a "Lab trials" section: trials with outcome and pass counts, a requirement-by-trial grid (symbols and words, so it prints in black and white), and, with technical access, the formula, what changed, observations, extra fields, files on file and the number of corrections. Without technical access the structure is shown and the rest is marked confidential.
* **Not built:** publishing a formula to a production recipe, a bell entry for trials, and any change to how stages are completed or approvals work.

**On the page:** a "Trials" tab (only for people with `rd.trial_view`) with an "Add trial" button (only for people who may add), a bar chart of how many requirements passed in each trial, a grid of requirements against trials (Pass, Fail and Not tested shown with a symbol and a word as well as colour), a table of trials, and a dialog to open a trial and see its correction history. The chart and grid have text alternatives.

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


## Away and cover

The page **Away and cover** (menu entry for R&D) is where absences are asked for, approved and watched.

**The steps**
1. **The person asks.** They give the type (Leave, Travel, Training, Sick, Other), the first and last day (up to 90 days), a reason and notes for the person who will cover. While typing, the page shows the **work that will be waiting**: open tasks due by the last day (or with no date), stages they are in charge of and work waiting for them to check. They may *suggest* a cover, but do not have to.
2. **The manager approves and chooses who will cover.** Anyone holding `rd.cover_approve` (the Manager, and administrators) sees the request under "Waiting for you", picks the person (people who are away on those dates cannot be picked), and approves, or says no with a reason. Nobody approves their own absence (an administrator, who has nobody above, may). A manager who writes an absence down for someone else settles it on the spot and must choose the cover.
3. **The chosen person is told.** It is an instruction from the manager, so they do not have to accept it. They get a notice (and the notes) straight away, and the cover starts on the first day. If there is a real problem (for example they are away or have a clash) they press **Tell the manager there is a problem** and write a few words. That does not stop anything by itself: the manager reads it and decides, for example chooses someone else (the problem is then cleared and the new person is told).
4. **The cover starts on the first day** once the manager has approved and chosen. The calendar shows where it is ("Waiting for the manager", "Approved. Cover not chosen yet", "Ready", "Cover reported a problem", "Away now").

**What the cover gets while it is active:** the person's open tasks in My Day ("Covering for ..."), the work waiting for them to check and the stages they are in charge of, their notices and morning-message items, and the notes. Everything the cover does is recorded "on behalf of" the person away, who is told. The task stays theirs, and the cover can never check work they did for someone.

**Changing it:** the person can change the dates, type, reason, notes and suggestion. New dates go back to the manager. Once the manager has chosen, only the manager changes the cover (the new person is told). A started absence cannot move its first day. Either can cancel it; the person covering can stop covering.

**Around it:** giving a task to someone who is away shows a warning that names the cover, and the people list marks who is away; a six-week calendar (with a table for screen readers) shows who is away; "While you were away" lists what was done for the person and what has come in; it ends by itself after the last day. Existing absences were treated as approved and confirmed when this was added.

**Reminders:** the manager gets a notice and a morning-message line until each request is decided or has a cover, and when a cover reports a problem. Notices never include the notes.

**Numbers:** work done by a cover counts as the cover's completion, not the person's, in Team Performance.
