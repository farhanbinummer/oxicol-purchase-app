# TaskFlow link and read-only task summary

TaskFlow Teams is a **separate** app (its code is on the `taskflow-teams` branch). The two stay separate. Oxicol only does two things with it.

## 1. The "Tasks" link
Every workspace's sidebar has a **Tasks** entry that opens TaskFlow in a new tab (`target="_blank"`, `rel="noopener noreferrer"`).
`TASK_APP_URL` sets the address. Not set: `https://steady-frangollo-e2886d.netlify.app/`. Set but empty: the link is hidden. Only https addresses are accepted.

## 2. The task summary card (Manager and Administrator dashboards)
Shows counts only: **overdue tasks** (the main number), open, due today, done in the last 7 days, and the names of the (at most three) people with the most overdue tasks.

- Rules are TaskFlow's own: a repeating task (`recur` not `none`) is never overdue; a task is overdue when it is not done and its due date is before today; dates are `YYYY-MM-DD`; "today" is India time (Asia/Kolkata). "Open" means not done (repeating tasks included). "Done in the last 7 days" is today and the six days before, by the task's completed date.
- Names come from the `assignedToName` stored on each task, so a person renamed in TaskFlow may show their old name on tasks created before the rename.
- Task titles, descriptions and chats are never copied, stored or sent to the browser. Nothing is written to TaskFlow and nothing is stored in Oxicol's database.
- Who sees it: the permission `tasks.summary_view` (Roles and Permissions, module "Tasks (TaskFlow)"). The Manager holds it by default; administrators hold every key. Migration `028_tasks_summary_permission` gives it to the Manager on existing databases.
- It cannot slow the dashboard down: the page asks for the numbers separately (`GET /api/workspace/task-summary`) after the dashboard has loaded. The answer is kept for one minute, every request stops after about five seconds, and a failure is remembered for 20 seconds. If TaskFlow cannot be reached the card says so quietly instead of showing an error.
- How it reads: Oxicol signs in to Firebase once with a reader account (REST sign-in), keeps the sign-in token in memory only, and makes **GET** requests to `taskflow/tasks` only. The password and token are never logged.

### Settings (Render, Environment)
All four must be set, otherwise the card is simply not shown.

| Variable | What to put |
|---|---|
| `TASKFLOW_FIREBASE_API_KEY` | Firebase console, Project settings, General, "Web API Key" |
| `TASKFLOW_DATABASE_URL` | the Realtime Database address, `https://....firebaseio.com` (https only) |
| `TASKFLOW_READER_EMAIL` | the email of the reader account below |
| `TASKFLOW_READER_PASSWORD` | its password |

### Create the reader account (Firebase console)
1. Open the Firebase console for the TaskFlow project, then **Authentication**, **Users**, **Add user**.
2. Enter an email such as a mailbox you control for this purpose (it does not need to receive mail) and a long random password. Save it in a password manager.
3. Do **not** add this account in TaskFlow itself: it has no TaskFlow user record and no TaskFlow role.
4. In Render, open the Oxicol service, **Environment**, add the four variables, save, and let it redeploy. Never paste the password anywhere else.
5. Open the Manager dashboard: the card appears after a moment. To switch it off, delete any one of the four variables.

### Important: keep the reader account dedicated
TaskFlow's database rules (`database.rules.json`) let **any signed-in account read and write `taskflow/tasks`** (and chats, orders, notifications). Oxicol only ever reads, but the account itself could write. So:
- use this account for Oxicol and nothing else, never for a person;
- keep its password only in Render's Environment settings;
- if it is ever exposed, delete the user in Firebase Authentication and create a new one;
- tightening those rules (for example, reads only for this account) is a change to TaskFlow, not Oxicol, and is not done here.
