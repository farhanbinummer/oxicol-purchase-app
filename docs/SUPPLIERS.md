# Suppliers

Menu: **Suppliers** (Purchase: Buying; Manager: Progress; Accounts: Finance; Administrator: Master Data). On a new purchase order, **+ Add a new supplier** next to the supplier box opens the same screen ready to add one.

**Who can do what**
- Everyone who may see suppliers (Purchase, Manager, Accounts, administrators) can read the list.
- **Purchase and the Manager** (new permission `suppliers.manage`) can add suppliers, edit them and switch them on or off. An administrator can change who holds it in Roles and Permissions.
- **Bank details** (bank name, account number, IFSC) are shown to, and accepted from, only people who already hold bank access (Purchase and Accounts). The Manager does not see them and cannot set them, but can still edit everything else without wiping them.

**Fields:** name (required), contact person, phone, email, GST number, and (with bank access) bank name, account number and IFSC.
- **GST number:** optional, 15 characters in the usual pattern (for example `32ABCDE1234F1Z5`), saved in capitals. It cannot be used for two suppliers.
- **Name:** cannot repeat (capital letters do not matter).
- Phone needs at least 7 digits; email must look like an email; IFSC is 4 letters, a 0, then 6 letters or digits.

**Switching off:** the supplier stops appearing on new purchase orders. Old orders and payments keep it, and it can be switched back on. Taking a supplier out of the app completely is on Remove Data (only while no order or payment uses it).

**History:** every add, change, switch on and switch off is in the Audit History with the old and new values. The account number is kept only as its last four digits there.

**Search:** by name, GST number, contact person or phone. The list shows how many orders and payments each supplier has.
