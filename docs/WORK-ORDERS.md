# Stock and work orders (production batches)

## Stock in store
- A ledger: the stock of a raw material is the sum of its movements. **Stock** screen (Stores, Production, Quality, Purchase, Manager, Administrator can view; Stores and the Administrator can correct).
- **Goods received** are added automatically when a goods receipt passes quality check (at "QC approved" when saving, or when QC approves it later). The quantity is what was *received*. Lines marked *Damaged* are not added. A line is matched to a raw material by its **name** (capital letters ignored); lines with no matching raw material are reported and not added.
- **Existing stock is not known to the app.** Receipts approved before this feature are not added. Stores enters opening stock once per material with **Add or correct stock** (a reason is required; stock cannot go below zero).
- Removing a goods receipt or an order in the Administrator's "Remove data" screen takes the stock it added back out. A raw material that has stock records or work orders cannot be removed (switch it off instead).

## Work orders (batches)
1. **Production plans** a batch: finished product + quantity (+ date, notes). The materials come from the product's active recipe (wastage as in the recipe) and are shown against what is in store. Batch number `BT-26-27-001` (financial year + running number). Needs a recipe.
2. **Stores issues** the materials. All must be in store (otherwise the issue is refused and says what is short); Stores may issue less than planned by changing the quantities. The stock goes down.
3. **Production records the result**: quantity made and date. The yield % is shown.
4. **Quality check** passes or fails the batch (a reason is needed to fail it).
- A planned batch can be changed (quantity, date, notes: the materials are recalculated). Before the result is recorded a batch can be cancelled with a reason; an issued batch puts its materials back into stock.
- Notifications: Stores when a batch is planned; Production when materials are issued; Quality when a batch is finished; Production and Stores with the quality decision.
- **Print batch sheet** on the work order page.

## Not included
Finished goods stock, batch costing, and recording actual use against the issued quantity (only planned and issued are recorded).
