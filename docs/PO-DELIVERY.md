# Expected delivery date and dispatch (tracking) details

On a purchase order page, the **Delivery and tracking** section shows the expected delivery date, the dispatch details and a history of every change.

**Expected delivery date**
- **Set / Update expected date.** Changing an existing date needs a short reason ("supplier said 3 days late"). Setting a date for the first time needs none.
- The new date is what **Expected Deliveries** uses for "Due today", "Due in 7 days" and "Overdue".
- It cannot be before the order date or more than a year ahead (typo protection), and cannot be changed once the order is delivered.

**Dispatch details** (Enter / Update dispatch details)
- Transporter or courier, tracking or LR number, vehicle number, dispatch date and an optional tracking link (must start with `https://`).
- At least the transporter, tracking number or vehicle number is needed. The dispatch date cannot be in the future or before the order date.
- Changing existing details needs a reason. The old and new values are kept.
- The tracking number is a link when a tracking page is given (opens in a new tab).
- **Expected Deliveries** shows "On its way since ... with ..., tracking ..., vehicle ..." so Stores knows what to expect.
- Entering details does **not** change the order's status. A tick box, **Also mark this order as In transit**, appears only once payment is done (an advance payment can only be recorded before the order is "in transit", so marking it earlier would block that).

**Expected Deliveries page** (Stores, Purchase, Manager)
- One card per order waiting for goods, with a colour stripe: red = overdue, amber = due today, green = on its way, grey = no date.
- Each card shows the expected date with how many days late or to go, and a **Dispatch and tracking** box: transporter, tracking or LR number, vehicle, dispatch date. **Track shipment** opens the tracking page in a new tab; **Copy tracking number** copies it.
- Purchase and the Manager can **Change date**, **Set date**, **Add dispatch details** and **Update details** right on the card (same forms as the order page). Stores sees the details and a **Receive goods** button that opens the receipt form with that order already chosen.
- Filter buttons with counts: All waiting, Overdue, Due today, Due in 7 days, On its way, No date set. Links from dashboard cards (`?when=overdue`, `today`, `soon`) still work.
- The search box finds an order by order number, supplier, tracking number, vehicle number, transporter or item name (for example when a lorry arrives at the gate).

**Who:** a new permission, `po.update_delivery`, held by **Purchase** and the **Manager** (administrators hold every key). It is seeded by migration `032_po_delivery_tracking`. Stores, Purchase and the Manager are sent a notice when the date or the dispatch details change.

**History and audit:** every change is listed on the order (who, when, old value, new value, reason) and recorded in the Audit History. The history goes with the order if an administrator removes it.

**Not included yet: automatic tracking.** Details are typed in by hand. Fetching the live status from a courier needs a connection and a key for each courier, and most lorry transport (LR) numbers have no public tracking at all. See the notes in the project discussion before adding this.
