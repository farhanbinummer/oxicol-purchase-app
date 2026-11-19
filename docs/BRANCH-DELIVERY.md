# Branch confirms delivery

Until now a branch request ended at "approved / being prepared". The branch can now tell the app what actually arrived.

**What the branch does** (Branch Stock Requests, open a request that is approved or being prepared, section **Delivery**)
1. For each item enter how many **arrived now**, and how many of those were **damaged**. Deliveries often come in parts: save what has arrived, come back when the rest does.
2. Damage needs a short note ("5 tins dented"). That is all the app asks.
3. If the rest is not coming (the supplier cancelled, for example), tick **"This is everything that will arrive"** and write why. The request is then closed as short.

**What everyone sees**
- Request details: requested / received / damaged / still expected for every item, and the history of confirmations (who, when, note).
- Request list: a **Delivery** column ("Not received yet", "60 of 110 received", "Received", "Closed short").
- Branch dashboard: a card **Deliveries to confirm** (delivery date reached, not all confirmed). A fully received request leaves the "to do" list. The button says "Confirm delivery" once the date has come.
- Manager dashboard and the branch's own list: damage or a short close appears under **Exceptions**. The Manager and Purchase are also sent a notice when a problem is reported.

**Rules**
- Only the branch concerned (and administrators) can confirm. New permission **branch_request.confirm_delivery**, given to the Branch role by default and seeded for existing databases by migration `030_branch_delivery`. The Manager does not hold it; an administrator can grant it in Roles and Permissions.
- Only approved requests can be confirmed. Nothing can be confirmed for more than is still expected, and two people saving at the same moment can never receive more than was requested.
- Confirming only records facts. It does not change the request's status, and nothing about stock quantities in the app is changed (the app does not track branch stock).
- Every confirmation is in the audit history. Confirmations cannot be edited; a wrong entry is explained to the Manager, and an administrator can remove the whole request's data if needed.

**Not included yet:** a dispatch step on the head-office side (who sent what, vehicle, date), photos of damaged goods on a branch delivery (receipts at head office already take photos), and reminders for branches that never confirm.
