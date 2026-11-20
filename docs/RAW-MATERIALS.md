# Raw material list: type and choose

The raw material list from the billing software (SherSoft report, 241 items) is loaded into the app (migration `031_raw_material_list`, data in `database/raw-materials-sher.json`).

**Where it is used**
- **Purchase order** (Items): type a few letters of the name or the item code, choose from the suggestions. The unit is filled in when the list has one (you can still change it), and the HSN code is saved on the order line.
- **Production request** (Chemicals needed): the same.
- Choosing is by keyboard or touch: arrow keys, Enter to choose, Esc to close.
- A chosen material's list name is what is saved, so one material is always spelt one way (good for reports and for planning).
- Something that is **not on the list** can still be typed. It is saved as typed and the row shows "Not from the list: saved as typed".

**What the import did and did not do**
- 241 items in the billing list; 91 were already in the app for the recipes and kept their name, unit and category (only an empty HSN code and GST rate were filled in). 150 new items were added as category "Raw material".
- **Units are never guessed.** The billing list gives no unit for 70 items; 39 of them are new in the app and have an empty unit (listed below). The order form leaves the unit to the person until an administrator sets it. Three existing materials have a different unit in the billing list (OXALIC ACID, BUTYL CELLOSOLVE, DUDEED CAN 5 LTR CARBOY MW); the unit the recipes already use was kept.
- Three materials in the app are not in the billing list (GLASS CLEANER RAW, PR TYRE GEL, HK PERFUME). They stay and are still offered.
- Running the import again changes nothing and never undoes an administrator's edit.
- The billing list's category is a single "RAW MATIRIALS" for everything, so no packaging/raw split was inferred for the new items.

**Keeping the list up to date: Master Data, Raw Materials** (administrators only)
- Search by name or code; chips show **All**, **No unit yet** and **Switched off** with their counts.
- **Edit** a material: name, unit (Kg, Litre, Nos, Box or Drum), category (Raw material or Packaging), HSN code (4 to 8 digits), GST rate, and whether it is offered when people type. Names are tidied and cannot repeat (capital letters do not matter). The item code comes from the billing software and is not changed.
- **No unit yet:** tick several and give them all one unit in one step. This only fills empty units; it never changes a unit that is already set.
- **Switching a material off** hides it from the type-and-choose list. Recipes and old orders that use it are untouched, and it can be switched back on.
- **Add a material** that is not in the billing list yet (code, name and unit are needed).
- Every change is in the Audit History with the old and new values. Taking a material out of the app completely is on Remove Data (not possible while a recipe uses it).
- To load a newer SherSoft export, send it and the list file is regenerated; existing materials are not overwritten.

**New items with no unit yet (39)**

| Code | Name |
|---|---|
| 427 | PLATE |
| 428 | DIE CHARGES |
| 445 | PET 28MM 1000ML BOSTON BLACK BOTTLE |
| 446 | DISCTOP 28MM CAP BLACK |
| 447 | INNER 28MM |
| LW1 | LABEL HK WHEEL CLEANER 1KG |
| LC6 | LABEL DU CAR SHAMPOO 650ML |
| 458 | CALCINED ALUMINA ULTIMATE 2500 |
| 470 | ACID SLURRY LIQUID |
| 473 | LABEL HK PERFUME |
| 475 | GST BILL |
| 479 | LABEL HK ALL PURPOSE 1KG |
| 495 | LABEL FOR CLOTH |
| 496 | STAND LABEL |
| 499 | SABAYA RAW FR487 |
| 500 | ENGLISH LOVE PERFUME RAW FR459 |
| 509 | BUTYL ACETATE-1 |
| 516 | MISC |
| 517 | PHOSPHORIC ACID |
| 518 | WACKER E 41 3 |
| 519 | REWOQUAT CQ AL 200 |
| 523 | LABEL HK CERAMIC BOOSTER |
| 524 | MISFIT PRFUME RAW |
| 530 | AEROSIL 200 |
| 531 | AMMONYX LMDO |
| 532 | STEPOSOL MET-10U |
| 542 | YELLOW WAX RAW |
| 543 | 28 MM YELLOW PULL PUSH CAP |
| 545 | SODIUM XYLRNR SULFONATE |
| 549 | ACID VIOLET |
| 554 | CALCINED ALUMINA RAPOL 600 |
| 561 | REHEOVIS PU 1280 (POLYURETHANE THICKNER) |
| 562 | LABEL HK GOLDEN WAX |
| 563 | LABEL HK COLOUR FOAM 5KG |
| 564 | LABEL HK TYRE GLO 5KG |
| 568 | CITRIMET |
| 570 | TRI ETHANOLAMINE (TEA) |
| 611 | 100ML BOTTLE WITH FLIPTOP CAP |
| A724 | VINNOL H15/45 M |
