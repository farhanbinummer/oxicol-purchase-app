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
