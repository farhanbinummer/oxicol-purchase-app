# Checklist: running your first real R&D project

The app has only been tested on a test copy with made-up data. This checklist is for the first real use, so problems show up on one small project and not on everything at once. Tick each box. Write down anything that annoys, confuses or stops someone.

## A. Before anyone starts (administrator, about 30 minutes)

- [ ] **Take a database backup and check you can restore it** (see `BACKUP-AND-RECOVERY.md`). Do this first.
- [ ] **Deploy the latest version** and check the Render log shows `Migration applied` lines with no errors.
- [ ] **Grant the sign-off permissions.** Administration > Permissions. Until this is done, stages 4, 6 and 8 cannot be completed.
  - QC role: *QC sign-off*
  - Production role: *Production handover acknowledgement*
  - Manager role (the Boss): *Management decision*, and *R&D Head decision* if the Boss approves projects
  - Customer approval evidence is recorded by an R&D person, who needs the *customer approval* permission
- [ ] **Create one account per person** (Administration > Users). Never share a login: every action is recorded under the signed-in name.
  - R&D people: role **R&D**
  - Trainees: role **R&D trainee**
  - The Boss: role **Manager** (the only role that can raise requests, besides administrators)
  - Passwords are temporary. Each person is made to choose their own at first sign-in (8 or more characters, not a common password).
- [ ] **Remove or disable test and duplicate accounts** (for example two accounts for the same person).
- [ ] **Open the site once as each role** and check the menu looks right.

## B. The pilot project (choose a small, real one)

- [ ] The Boss raises the request (New R&D request).
- [ ] The R&D lead opens it, sets the **Project lead**, trial days and feasibility, then **Fill in empty planned dates**.
- [ ] Stage 1: the owner **assigns part of the stage** to a trainee, choosing the form the trainee should fill in. The trainee finds it on **My Day**, fills the form and submits it. The owner reviews it (accept once, send back once to see both).
- [ ] The owner ticks the checklist items with results, and completes stage 1.
- [ ] Carry on to at least **stage 4**: QC records the sign-off, and the stage completes.
- [ ] Print one **stage report** and one **project report**. Ask: would you show this to a customer?
- [ ] Try the things that can go wrong: a task with no form, an out-of-range result, a task cancelled with a reason, a stage blocked by open work, a task reopened.

## C. What to watch during the first week

- [ ] Does everyone open **My Day** without being reminded? (There are no email or WhatsApp reminders yet; the bell and My Day are the only prompts.)
- [ ] Do tasks sit "waiting for review"? Who is slow to review?
- [ ] Are people writing useful results, or just filling boxes to get past the screen?
- [ ] Is anything missing that people keep doing on paper or in WhatsApp (photos, PDFs, lab sheets)? List it. That decides what to build next.
- [ ] Any page that is slow, confusing, or breaks on a phone? Note the page and what you did.

## D. Send back to the developer

For each problem: the page address, what you clicked, what you expected, what happened, and a screenshot. Also the time, so the server log can be checked.

## Known limits (so nobody is surprised)

- No photo or PDF attachments yet.
- No cover when someone is away. Reassign their tasks by hand (open the task, change "Responsible person").
- No email or WhatsApp reminders; people must open the app.
- The forms in "What should they bring back?" are a fixed starter set. Owners can customise them per task, but an administrator cannot yet edit the library.
- Only R&D tasks work this way. Purchase, Stores and Accounts have not been changed.
