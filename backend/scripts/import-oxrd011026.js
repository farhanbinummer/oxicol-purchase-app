// scripts/import-oxrd011026.js - brings the project that was already running on paper into the R&D module.
//
//   node scripts/import-oxrd011026.js                         dry run: shows exactly what would be created, changes nothing
//   node scripts/import-oxrd011026.js --apply                 creates the project (once; running it again does nothing)
//   node scripts/import-oxrd011026.js --apply --stages-completed-on=YYYY-MM-DD --owner-confirmed
//                                                             ALSO records the eight stages as completed on that date
//
// What this does NOT do, on purpose:
//   - It does not invent anything. Only details that were reported are filled in; every other field stays empty.
//   - The launch date is "To be confirmed". The old 01-11-2020 date is not used.
//   - The reported completion of all eight stages on the same day is NOT imported unless the owner has confirmed it and the two
//     flags above are given. Without them the stages are left not started, so nothing is reset, erased or reinterpreted here.
//   - Approvals (QC sign-off, customer evidence, handover) are not created. They are recorded by the people who give them.
//   - It never creates a second copy: a project with this number or with this import marker makes the script stop and say so.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require('../database');
const R = require('../rd-logic');

const NUMBER = 'OXRD011026';
const MARKER = 'reported-record-oxrd011026';
const REQUEST_DATE = '2026-10-31';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirmed = args.includes('--owner-confirmed');
const completedOn = (args.find(a => a.startsWith('--stages-completed-on=')) || '').split('=')[1] || null;

const PROJECT = {
  title: 'Under chassis coating',
  project_type: 'New Product Development',
  priority: 'High',
  department: 'R&D Internal',
  requested_by_name: 'Saifudheen',
  request_date: REQUEST_DATE,
  target_tbc: true, target_launch_date: null,
  brand_product: 'HERAKLEON',
  product_category: 'Underchassis / Antirust Coating',
  base_system: 'Solvent-based',
  description: 'Under chassis coating, bitumen or non-bitumen based, resistant to diesel wash, rubberised, chip resistant and anti-rust.',
  application_method: 'Schutz gun / spray',
  substrate: 'Primed or bare metal',
  end_user_market: 'Detailing shops',
  benchmark: '3M, Autochrome, PPG'
};

function fail(msg) { console.error('\n' + msg + '\n'); process.exitCode = 1; }

(async () => {
  console.log(apply ? 'APPLY mode' : 'DRY RUN (nothing will be changed; add --apply to create the project)');
  if ((completedOn || confirmed) && !(completedOn && confirmed)) return fail('Recording completed stages needs BOTH --stages-completed-on=YYYY-MM-DD and --owner-confirmed.');
  if (completedOn && (!R.isValidDate(completedOn) || completedOn > R.todayIST())) return fail('--stages-completed-on must be a real date that is not in the future.');

  const t = await pool.query("SELECT to_regclass('rd_projects') AS t");
  if (!t.rows[0].t) return fail('The R&D tables do not exist yet. Start the application once (or run the migrations) and try again.');

  const found = await pool.query('SELECT id, project_number, title, imported_from FROM rd_projects WHERE project_number = $1 OR imported_from = $2', [NUMBER, MARKER]);
  if (found.rowCount) {
    const p = found.rows[0];
    if (p.imported_from === MARKER) { console.log(`Already imported as project id ${p.id} (${p.project_number}). Nothing to do.`); return; }
    return fail(`The number ${NUMBER} is already used by a different project (id ${p.id}: "${p.title}"). Nothing was changed. Check that record first; this script will not overwrite or duplicate it.`);
  }

  console.log('\nWould create project ' + NUMBER + ':');
  Object.entries(PROJECT).forEach(([k, v]) => console.log('  ' + k.padEnd(20) + (v === null ? '(empty)' : v === true ? 'yes' : v)));
  console.log('  status              Received');
  console.log('  stages              8 stages created, ' + (completedOn ? `all marked completed on ${R.dmy(completedOn)} (owner confirmed)` : 'NOT started (the reported same-day completions are not imported)'));
  console.log('  approvals           none created');
  console.log('  month counter       raised to at least 1 for period ' + R.periodOf(REQUEST_DATE) + ', so the next request is numbered ' + R.numberFor(2, REQUEST_DATE));
  if (!apply) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const again = await client.query('SELECT 1 FROM rd_projects WHERE project_number = $1 OR imported_from = $2 FOR UPDATE', [NUMBER, MARKER]);
    if (again.rowCount) { await client.query('ROLLBACK'); return fail('Someone created it a moment ago. Nothing was changed.'); }
    const cols = Object.keys(PROJECT);
    const ins = await client.query(
      `INSERT INTO rd_projects (project_number, is_draft, status, submitted_at, imported_from, ${cols.join(', ')})
       VALUES ($1, FALSE, 'Received', NOW(), $2, ${cols.map((_, i) => '$' + (i + 3)).join(', ')}) RETURNING id`,
      [NUMBER, MARKER, ...cols.map(k => PROJECT[k])]);
    const id = ins.rows[0].id;
    await client.query('INSERT INTO rd_number_counters (period, last_serial) VALUES ($1, 1) ON CONFLICT (period) DO UPDATE SET last_serial = GREATEST(rd_number_counters.last_serial, 1)', [R.periodOf(REQUEST_DATE)]);
    for (const st of R.STAGES) {
      const s = await client.query('INSERT INTO rd_stages (project_id, stage_no) VALUES ($1,$2) RETURNING id', [id, st.no]);
      for (let i = 0; i < st.checklist.length; i++) await client.query('INSERT INTO rd_checklist_items (stage_id, position, label) VALUES ($1,$2,$3)', [s.rows[0].id, i, st.checklist[i]]);
      if (completedOn) {
        await client.query('UPDATE rd_stages SET actual_date = $1, completed_at = NOW() WHERE id = $2', [completedOn, s.rows[0].id]);
        await client.query("INSERT INTO rd_stage_history (stage_id, action, action_date, reason) VALUES ($1,'completed',$2,'Imported from the reported record on the owner''s confirmation')", [s.rows[0].id, completedOn]);
      }
    }
    await client.query("INSERT INTO rd_approvals (project_id, kind, decision, decision_date, remarks) VALUES ($1,'submission','submitted',$2,'Imported from the reported record')", [id, REQUEST_DATE]);
    await client.query("INSERT INTO rd_updates (project_id, kind, author_name, body) VALUES ($1,'system','System',$2)", [id,
      `Imported from the reported project record as ${NUMBER}. Launch date to be confirmed. ` + (completedOn ? `The eight stages were recorded as completed on ${R.dmy(completedOn)} on the owner's confirmation; no approvals were recorded.` : 'Stage completions were not imported; they are recorded here as the work is confirmed.')]);
    await client.query('COMMIT');
    console.log(`\nCreated project id ${id} (${NUMBER}).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail('Import failed and was rolled back: ' + err.message);
  } finally { client.release(); }
})().catch(e => fail(e.message)).finally(() => pool.end());
