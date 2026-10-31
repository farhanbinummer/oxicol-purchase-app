# Migration notes - Phase 1

Migrations live in `backend/migrate.js` and run automatically when the server starts. Each runs **once**, inside a transaction, and is recorded in `app_migrations`. They only **add** tables, columns and rows; nothing is dropped, renamed or rewritten, except one index swap noted under 002.

## Before you deploy to the live (Supabase) database

1. Take a backup (Supabase dashboard > Database > Backups, or `pg_dump`). The database must be **restored from "Paused"** first.
2. Deploy. Start-up logs show `Migration applied: 00x_...` for each step.
3. Open Administration > System Status to see which migrations are applied.
4. Open Master Data > Catalogue Review and link any legacy items.

A local backup taken before the first run is at `C:\Users\USER\android-build\oxicol-local-before-phase1.sql` (local database only).

## Steps

| Step | What it does | Backfill / decisions |
|---|---|---|
| 001_catalogue | Adds `code`, `category`, `pack_size`, `base_unit` to `products`; `category`, `active` to `raw_materials`; creates `product_aliases` | Codes `FG-0001...` assigned by id. Pack size read from the name (e.g. "5 KG"); left blank when the name has none. Raw-material category **inferred** from the unit guessed at BOM load (Nos = Packaging, else Raw material). Adds 9 finished products from the BOM sheet's "no data" tab with no recipe |
| 002_recipe_versions | Creates `recipe_versions`; adds `bom_lines.recipe_id` | Each product that had recipe lines gets **version 1** (active, effective on the migration date, output quantity 1, "quantities include wastage" = true, because the sheet's figures came from real usage). Replaces the old unique (product, material) with unique (recipe, material) so versions can share materials |
| 003_request_items_catalogue_link | Adds `product_id`, `mapping_status` to `branch_request_items` | Linked automatically **only** on an exact name match (ignoring case/spaces). Everything else is `needs_review` and is never guessed. On the local database 3 test items were flagged |
| 004_audit_log | Creates `audit_log` | History before this point is not reconstructed |
| 005_material_plans | Creates `material_plans` (recipe versions and inputs used by each approved plan) | Plans made before this existed have no snapshot |
| 006_catalogue_permissions | Grants the two new permission keys to their default roles | Existing grants are untouched, so an administrator's earlier edits stay |

## Unresolved mappings (need a person)

- Legacy request items with `mapping_status = 'needs_review'`: resolve in **Catalogue Review**.
- Raw-material units/categories: review in Master Data > Recipes.
- The 9 products with no recipe: enter recipes (or deactivate them) in Master Data.
- BOM sheet note: "HK ALL PURPOSE POLISH 5 KG" was flagged "may have partial data" in the source file and was loaded as given.

## Rolling back

Because nothing is dropped, an older version of the app mostly keeps working against the migrated database; the new tables and columns are simply ignored. One exception: the previous release's recipe *editing* relied on the unique (product, material) rule that step 002 replaces, so editing recipe lines in the old release would fail. To fully undo, restore the backup. Do not delete rows from `app_migrations` unless you also remove what the step created, or it will be re-applied.

## Also new (not a migration)

`backend/notify.js` still adds `users.email/phone` and `branch_stock_requests.priority` at start-up, and `backend/bom.js` creates the original recipe tables and loads the 29-product BOM only when the products table is empty.

---

# Migration notes - role workspaces (steps 007 and 008)

Run automatically at server start, once each, in a transaction. **Take a backup first** (Supabase > Database > Backups, or `pg_dump`).
A local backup taken before they were first run is at `C:\Users\USER\oxicol-local-before-workspaces.sql` (local database only).

| Step | What it does | Existing data |
|---|---|---|
| 007_roles_scopes_workspaces | Creates `user_roles`, `user_scopes`, `user_workspace_prefs`. Replaces the two CHECK lists (`users.role`, `role_permissions.role`) so `manager` and `qc` are allowed. | Every user gets one `user_roles` row equal to their current role; every branch user gets one `user_scopes` row equal to their current branch. `users.role` and `users.branch` are untouched and remain the **primary** role/branch. |
| 008_field_visibility_and_new_roles | Adds the permission keys `field.prices` and `field.supplier_bank`; seeds default permissions for the new `qc` and `manager` roles. | Existing action grants are not touched (an administrator's earlier edits stay). `purchase` and `accounts` receive the two field keys so they see exactly what they saw before. **Stores does not**, which is the one deliberate narrowing: it no longer receives prices or supplier bank details until an administrator ticks the two boxes. |

Verified on the local database: 9 users, 9 role rows, 0 mismatches; 4 branch users, 4 scope rows, 0 mismatches; running the steps again changes nothing.

## Unresolved mappings / decisions

See "Decisions needed from the business" in [../docs/WORKSPACES.md](../docs/WORKSPACES.md): payment references for Stores, splitting Stores' three jobs,
the Administrator's blanket approvals, approval thresholds, manager payment confirmation, branches and warehouses as master data.

## Rolling back

Nothing is dropped. An older release keeps working with most screens because `users.role` still holds a valid role; but a person given
a new role (`manager`, `qc`) or several roles would not be understood by it. To undo completely, restore the backup. Do not delete rows
from `app_migrations` without also removing what the step created (the CHECK lists would be re-applied and the field keys re-inserted).

Accounts created directly in SQL (outside the application) without `user_roles` / `user_scopes` rows are still understood: the role is
read from `users.role` and a branch user's branch from `users.branch`.

---

# Migration notes - R&D projects (steps 009 and 010)

Run automatically at server start, once each, in a transaction. **Take a backup first** (Supabase > Database > Backups, or `pg_dump`). Steps 007 to 010 all run the first time the new release starts against the live database.

| Step | What it does | Existing data |
|---|---|---|
| 009_rd_projects | Creates `rd_projects`, `rd_number_counters`, `rd_requirements`, `rd_project_members`, `rd_stages`, `rd_stage_history`, `rd_checklist_items`, `rd_tasks`, `rd_updates`, `rd_approvals`, `rd_user_projects`. Replaces the two role CHECK lists (`users.role`, `role_permissions.role`) so the new `rd` role is allowed. | Nothing existing is read, changed or dropped. All new tables start empty. No project is created. |
| 010_rd_permissions | Seeds the `rd.*` permission keys and `field.rd_technical` for the roles listed in `docs/RD-PROJECTS.md`. | Existing grants are untouched (`ON CONFLICT DO NOTHING`). **No role receives an approval key.** |

Verified on the local database: both steps applied once, a second start applies nothing, existing purchasing tests still pass.

## Bringing in the project already running on paper (OXRD011026)

Not part of the migrations. Run `node scripts/import-oxrd011026.js` (dry run) and review the output, then `--apply`. See `docs/RD-PROJECTS.md`. The script refuses to run if the number is already used, and the reported same-day completions of the eight stages are imported only with `--stages-completed-on=YYYY-MM-DD --owner-confirmed`.

After importing, the month's counter is at least 1 for October 2026, so the next submitted request is `OXRD021026`.

## Rolling back

Nothing is dropped from existing tables. To undo completely restore the backup. If only the R&D data must go: drop the `rd_*` tables, delete the `009_rd_projects` and `010_rd_permissions` rows from `app_migrations`, and delete the `rd.*` and `field.rd_technical` rows from `role_permissions`; users given the `rd` role must first be moved to another role.
