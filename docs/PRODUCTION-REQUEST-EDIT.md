# Changing a production request

A production request (indent) can be changed by **the person who raised it, and only until it is approved**.

- **Who:** only the requester. Another person with the same role, the approver (Stores), the Manager and administrators cannot change it. The server checks this on every save, not only the screen.
- **When:** only while the status is "pending". Once it is approved the **Change this request** button disappears and a save is refused ("already approved"). If something is wrong after approval, ask the approver.
- **How:** on the request page, **Change this request** opens the form with everything filled in (head, materials, quantities, units, dates, priorities). Materials can be re-picked from the raw material list. **Save changes** replaces the request's lines as a whole.
- **The approver is told** ("Production request changed ... please look at it again") and the page shows "Changed once by its requester, last <date>".
- **The approver approves the version they saw.** The Approve button sends the version on screen. If the requester saved a change after the approver opened the page, the approval is refused with "changed it after you opened it" and the page reloads, so a request is never approved with lines the approver did not see. An edit and an approval at the same instant cannot both succeed.
- **A stale edit screen cannot overwrite a newer change** (the second save is refused: "changed since you opened it").
- **History:** every change is in the Audit History with the old and new head and lines.
- Database step `034_indent_edit` adds `edit_count` and `edited_at` to production requests.

Not changed: who may delete a pending request (still the existing delete permission) and branch stock requests (not editable).
