// rd-logic.js - the rules of the R&D module that do not need a database: reference lists, the eight development
// stages, project numbers, dates and scheduling. Kept pure so every rule can be tested directly.
//
// Dates are plain 'YYYY-MM-DD' strings everywhere (never Date objects), so a date can never shift with a time zone.
// "Today" is always the date in India (Asia/Kolkata). Durations are CALENDAR days; screens label them that way.

const PROJECT_TYPES = ['New Product Development', 'Reformulation / Improvement', 'Cost Reduction', 'Raw Material Substitution',
  'Customer Complaint', 'Competitor Benchmarking', 'Scale-up / Plant Trial', 'Packaging Change'];
const PRODUCT_CATEGORIES = ['Underchassis / Antirust Coating', 'Polishing / Rubbing Compound', 'Tyre Shine / Dressing', 'Tar Remover',
  'Rinse Aid / Car Wash', 'Ceramic / Protective Coating', 'Industrial Cleaner / Degreaser', 'Detergent', 'Other'];
const BASE_SYSTEMS = ['Water-based', 'Solvent-based', 'Emulsion', 'Powder', 'Aerosol', 'Paste / Gel'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const DEPARTMENTS = ['Management', 'Sales & Marketing', 'Production', 'QC', 'Purchase', 'Customer / OEM', 'R&D Internal'];
const STATUSES = ['Received', 'Under Review', 'Approved', 'In Lab Trials', 'Sample Sent', 'Plant Trial', 'Completed', 'On Hold', 'Rejected'];
const FEASIBILITY = ['Feasible', 'Feasible with Conditions', 'Needs More Information', 'Not Feasible'];
const COST_BASES = ['₹/kg', '₹/L'];

// "Active" means work is moving. On Hold is PAUSED (not active, not finished); Completed and Rejected are closed.
const ACTIVE_STATUSES = ['Received', 'Under Review', 'Approved', 'In Lab Trials', 'Sample Sent', 'Plant Trial'];
const CLOSED_STATUSES = ['Completed', 'Rejected'];
const HOLD_STATUS = 'On Hold';
const scopeOfStatus = (s) => (ACTIVE_STATUSES.includes(s) ? 'active' : s === HOLD_STATUS ? 'hold' : 'closed');

// The rows a new request starts with in its performance table (Parameter | Target | Range | Method | Benchmark | Remarks).
const DEFAULT_PERFORMANCE_ROWS = ['Viscosity', 'pH / Solids %', 'Drying / Cure Time', 'Gloss / Finish', 'Durability / Water Resistance',
  'Salt Spray / Corrosion (hrs)', 'Shelf Life / Stability', 'Adhesion'];

// The eight development stages, in order. `days` are calendar days. Stage 3 uses the project's own estimate when one is set.
// An approval that must exist before the stage can be completed is named in `needs` (it is checked by the server).
const STAGES = [
  { no: 1, name: 'Literature / Raw-Material Sourcing', days: 7, checklist: [
    'Study benchmark TDS and SDS', 'Shortlist raw materials and suppliers', 'Request material samples and quotations'] },
  { no: 2, name: 'First Lab Batch', days: 5, checklist: [
    'Record starting formula and batch size', 'Make the batch and record observations', 'Check viscosity, solids and appearance'] },
  { no: 3, name: 'Lab Trials & Optimisation', days: 21, checklist: [
    'Record trials and changed variables', 'Compare results against performance requirements', 'Identify the preferred formula and calculate raw-material cost'] },
  { no: 4, name: 'Internal Testing / QC Approval', days: 14, needs: 'qc_signoff', checklist: [
    'Run applicable tests', 'Compare results with specifications and benchmarks', 'Obtain QC sign-off'] },
  { no: 5, name: 'Sample to Requester / Customer', days: 3, checklist: [
    'Pack and label samples', 'Include a test summary or draft TDS', 'Record dispatch and recipient'] },
  { no: 6, name: 'Customer Approval', days: 14, needs: 'customer', checklist: [
    'Record written feedback', 'Track corrections and resubmissions', 'Record the decision and evidence'] },
  { no: 7, name: 'Plant Trial / Scale-up', days: 7, checklist: [
    'Prepare the plant batch card', 'Record the trial with Production', 'Compare plant and lab QC results'] },
  { no: 8, name: 'Handover to Production', days: 5, needs: 'handover_ack', checklist: [
    'Hand over the approved formula, SOP and QC specifications',
    'Finalise required safety documents, label and packaging information', 'Record handover acknowledgement'] }
];
const LAB_STAGE_NO = 3;
// Every checklist item asks for the result (what was found) before it can be ticked, except the two that are already
// recorded as a formal sign-off in the approvals table.
const NO_RESULT_LABELS = ['Obtain QC sign-off', 'Record handover acknowledgement'];
const needsResult = (label) => !NO_RESULT_LABELS.includes(label);
const MAX_RESULT_LENGTH = 2000;
// A task is completed by writing down what was done. Short enough to be quick, long enough that "ok" does not pass.
const MIN_TASK_RESULT_LENGTH = 10;
// A burst of clicks (or a script) must not be able to complete several stages of one project at once. After a stage is
// completed, the next completion on the same project has to wait this many seconds. Real stages take days; this only stops bursts.
const STAGE_COOLDOWN_SECONDS = Number.isFinite(Number(process.env.RD_STAGE_COOLDOWN_SECONDS)) && process.env.RD_STAGE_COOLDOWN_SECONDS !== undefined
  ? Number(process.env.RD_STAGE_COOLDOWN_SECONDS) : 10;
const APPROVAL_KINDS = ['submission', 'rd_head', 'management', 'qc_signoff', 'customer', 'handover_ack'];
const APPROVAL_DECISIONS = ['submitted', 'approved', 'rejected', 'returned'];
const APPROVAL_LABELS = { submission: 'Request submission', rd_head: 'R&D Head decision', management: 'Management decision',
  qc_signoff: 'QC sign-off', customer: 'Customer approval evidence', handover_ack: 'Production handover acknowledgement' };

/** Stage days for one project: stage 3 follows the project's estimated trial duration when it was supplied. */
function stageDays(stage, trialDays) {
  return stage.no === LAB_STAGE_NO && Number.isInteger(trialDays) && trialDays > 0 ? trialDays : stage.days;
}

// ---------------------------------------------------------------------------------------------------------------
// Dates (strings only)
// ---------------------------------------------------------------------------------------------------------------
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const toUtc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUtc = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (s, n) => fromUtc(toUtc(s) + n * 86400000);
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000); // b - a
const maxDate = (...ds) => ds.filter(Boolean).reduce((a, b) => (a >= b ? a : b), null);
/** Today's date in India, whatever the server's own time zone is. */
function todayIST(nowMs) { return fromUtc((nowMs == null ? Date.now() : nowMs) + 330 * 60000); }
const dmy = (s) => (s ? s.split('-').reverse().join('-') : '');

// ---------------------------------------------------------------------------------------------------------------
// Project numbers: OXRD + monthly serial (at least two digits, never truncated) + MM + YY, e.g. OXRD011026.
// ---------------------------------------------------------------------------------------------------------------
function formatProjectNumber(serial, month, year2) {
  return 'OXRD' + String(serial).padStart(2, '0') + String(month).padStart(2, '0') + String(year2).padStart(2, '0');
}
function periodOf(isoDate) { return isoDate.slice(2, 4) + isoDate.slice(5, 7); } // 'YYMM'
function numberFor(serial, isoDate) { return formatProjectNumber(serial, isoDate.slice(5, 7), isoDate.slice(2, 4)); }
/** Splits a number back into its parts, or null. The month and year are always the LAST four digits. */
function parseProjectNumber(n) {
  const m = /^OXRD(\d{2,})(\d{2})(\d{2})$/.exec(String(n || ''));
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { serial: Number(m[1]), month, year2: Number(m[3]), period: m[3] + m[2] };
}

// ---------------------------------------------------------------------------------------------------------------
// Scheduling. A stage is { no, days, planned, actual } with planned/actual as 'YYYY-MM-DD' or null.
// The planned date of a stage is the date it is due.
// ---------------------------------------------------------------------------------------------------------------
const currentStageNo = (stages) => { const s = stages.find(x => !x.actual); return s ? s.no : null; };

/**
 * Proposes planned dates for stages that have none. It never changes a date somebody entered.
 * A proposal starts from today or the latest earlier date (actual or planned), whichever is later, and adds the stage's days.
 */
function autoPlan(stages, today) {
  const proposals = [];
  let latest = null; // latest actual-or-planned date seen so far
  for (const s of stages) {
    if (s.actual || s.planned) { latest = maxDate(latest, s.actual || s.planned); continue; }
    const planned = addDays(maxDate(today, latest), s.days);
    proposals.push({ no: s.no, planned });
    latest = planned;
  }
  return proposals;
}

/** Contradictions in a schedule: stages out of order, a date before the one before it, or a finish after the launch target. */
function findConflicts(stages, targetLaunch) {
  const out = [];
  let prev = null;
  for (const s of stages) {
    const date = s.actual || s.planned;
    if (date && prev && date < prev.date) {
      out.push({ type: 'order', stage: s.no, message: `Stage ${s.no} is dated ${dmy(date)}, before stage ${prev.no} (${dmy(prev.date)}).` });
    }
    if (date) prev = { no: s.no, date };
  }
  const last = stages[stages.length - 1];
  const finish = last && (last.actual || last.planned);
  if (targetLaunch && finish && finish > targetLaunch) {
    out.push({ type: 'launch', stage: last.no, message: `The schedule ends on ${dmy(finish)}, after the target launch date ${dmy(targetLaunch)}.` });
  }
  return out;
}

/** Delay in days: completed = actual - planned; pending and past its date = today - planned; otherwise null. */
function delayDays(stage, today) {
  if (!stage.planned) return null;
  if (stage.actual) return daysBetween(stage.planned, stage.actual);
  return today > stage.planned ? daysBetween(stage.planned, today) : null;
}

/**
 * What the dates of the pending stages from `fromNo` onwards WOULD become if they were planned again from today. Nothing is
 * changed; the person sees the comparison and decides. Dates of completed stages are never touched.
 */
function replanPreview(stages, today, fromNo) {
  const cleared = stages.map(s => (!s.actual && s.no >= fromNo ? { ...s, planned: null } : s));
  const byNo = new Map(autoPlan(cleared, today).map(p => [p.no, p.planned]));
  return stages.filter(s => !s.actual && s.no >= fromNo).map(s => ({ no: s.no, current: s.planned, proposed: byNo.get(s.no) || s.planned, changed: (byNo.get(s.no) || s.planned) !== s.planned }));
}

// ---------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------
/** Performance rows: trims every cell and drops rows that are completely empty. */
function cleanRequirementRows(rows) {
  const keys = ['parameter', 'target', 'acceptable_range', 'test_method', 'benchmark_value', 'remarks'];
  return (Array.isArray(rows) ? rows : [])
    .map(r => Object.fromEntries(keys.map(k => [k, String((r && r[k]) == null ? '' : r[k]).trim()])))
    .filter(r => keys.some(k => r[k] !== ''));
}

/** Problems with a request that is being SUBMITTED (a draft only needs a title). Returns [{field, message}]. */
function validateRequest(p, submitting) {
  const errs = [];
  const need = (field, label, list) => {
    const v = p[field];
    if (v == null || String(v).trim() === '') errs.push({ field, message: `${label} is required` });
    else if (list && !list.includes(v)) errs.push({ field, message: `${label} must be one of: ${list.join(', ')}` });
  };
  if (!p.title || !String(p.title).trim()) errs.push({ field: 'title', message: 'Project title is required' });
  if (!submitting) {
    ['project_type:PROJECT_TYPES', 'priority:PRIORITIES', 'department:DEPARTMENTS', 'product_category:PRODUCT_CATEGORIES', 'base_system:BASE_SYSTEMS'].forEach(x => {
      const [f, l] = x.split(':'); if (p[f] != null && p[f] !== '' && !LISTS[l].includes(p[f])) errs.push({ field: f, message: `${f.replace(/_/g, ' ')} is not an allowed value` });
    });
    return errs;
  }
  need('project_type', 'Project type', PROJECT_TYPES);
  need('department', 'Department', DEPARTMENTS);
  need('priority', 'Priority', PRIORITIES);
  need('product_category', 'Product category', PRODUCT_CATEGORIES);
  need('base_system', 'Base system', BASE_SYSTEMS);
  need('description', 'Product description and intended use');
  if (!p.target_tbc && !p.target_launch_date) errs.push({ field: 'target_launch_date', message: 'Give a target launch date, or mark it "To be confirmed"' });
  return errs;
}
const LISTS = { PROJECT_TYPES, PRIORITIES, DEPARTMENTS, PRODUCT_CATEGORIES, BASE_SYSTEMS };

// ---------------------------------------------------------------------------------------------------------------
// Result forms: the person assigning a task decides what comes back. A task carries a COPY of its form (result_schema) so
// changing a starter form later never changes work already assigned. Answers are checked here, never trusted from the page.
// ---------------------------------------------------------------------------------------------------------------
const FIELD_TYPES = ['text', 'longtext', 'number', 'date', 'choice', 'yesno'];
const MAX_FORM_FIELDS = 20;
const num = (key, label, extra) => ({ key, label, type: 'number', required: true, ...(extra || {}) });
const txt = (key, label, required) => ({ key, label, type: 'text', required: required !== false });
const notes = () => ({ key: 'notes', label: 'Notes', type: 'longtext', required: false });
/** Ready-made forms. They are starting points: the person assigning can change the expected range and add fields. */
const FORM_TEMPLATES = [
  { id: 'viscosity', name: 'Viscosity check', description: 'Viscosity reading with temperature and spindle', kind: 'form', fields: [
    num('viscosity', 'Viscosity', { unit: 'KU', units: ['KU', 'cP', 's'] }), num('temperature', 'Temperature', { unit: '°C' }), txt('spindle', 'Spindle or method'), txt('sample', 'Sample or batch no.'), notes()] },
  { id: 'solids', name: 'Solids content', description: 'Percent solids and how it was measured', kind: 'form', fields: [
    num('solids', 'Solids', { unit: '%', min: 0, max: 100 }), txt('method', 'Method'), txt('sample', 'Sample or batch no.'), notes()] },
  { id: 'ph', name: 'pH check', description: 'pH value with temperature', kind: 'form', fields: [
    num('ph', 'pH', { min: 0, max: 14 }), num('temperature', 'Temperature', { unit: '°C' }), txt('sample', 'Sample or batch no.'), notes()] },
  { id: 'appearance', name: 'Appearance check', description: 'Colour, clarity and any defects', kind: 'form', fields: [
    txt('colour', 'Colour'), { key: 'clarity', label: 'Clarity', type: 'choice', required: true, options: ['Clear', 'Slightly hazy', 'Hazy', 'Opaque'] },
    { key: 'defects', label: 'Any defects?', type: 'yesno', required: true }, txt('defect_details', 'Defect details', false), notes()] },
  { id: 'raw_sample', name: 'Raw material sample received', description: 'Supplier sample details and condition', kind: 'form', fields: [
    txt('supplier', 'Supplier'), txt('material', 'Material'), txt('batch', 'Supplier batch no.'), num('quantity', 'Quantity', { unit: 'kg', units: ['kg', 'L', 'g'] }),
    { key: 'received', label: 'Received on', type: 'date', required: true }, { key: 'condition', label: 'Condition', type: 'choice', required: true, options: ['Good', 'Damaged', 'Leaking'] }, notes()] },
  { id: 'test_result', name: 'Test result (pass or fail)', description: 'A test, its standard and the outcome', kind: 'form', fields: [
    txt('test_name', 'Test'), txt('standard', 'Standard or specification', false), txt('result', 'Result'),
    { key: 'outcome', label: 'Outcome', type: 'choice', required: true, options: ['Pass', 'Fail', 'Needs repeat'] }, notes()] },
  { id: 'plant_trial', name: 'Plant trial observation', description: 'What happened in the plant trial', kind: 'form', fields: [
    { key: 'trial_date', label: 'Trial date', type: 'date', required: true }, num('batch_size', 'Batch size', { unit: 'kg', units: ['kg', 'L'] }),
    { key: 'observations', label: 'Observations', type: 'longtext', required: true }, { key: 'issues', label: 'Any issues?', type: 'yesno', required: true }, txt('issue_details', 'Issue details', false)] }
];

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Cleans a form definition from the page. Returns { schema } or { error }. Only known properties survive. */
function validateSchema(input) {
  if (!input || typeof input !== 'object') return { error: 'The result form is not valid' };
  const kind = input.kind === 'checklist' ? 'checklist' : 'form';
  const name = String(input.name || (kind === 'checklist' ? 'Checklist' : 'Result form')).trim().slice(0, 80) || 'Result form';
  const raw = kind === 'checklist' ? input.items : input.fields;
  if (!Array.isArray(raw) || !raw.length) return { error: kind === 'checklist' ? 'Add at least one step to the checklist' : 'Add at least one field to the form' };
  if (raw.length > MAX_FORM_FIELDS) return { error: `A form can have at most ${MAX_FORM_FIELDS} fields` };
  const used = new Set();
  const keyFor = (r, i) => { let k = /^[a-z][a-z0-9_]{0,39}$/.test(String(r.key || '')) ? r.key : (slug(r.label) || 'field_' + (i + 1)); if (/^[0-9]/.test(k)) k = 'f_' + k; let n = k, c = 2; while (used.has(n)) n = k + '_' + c++; used.add(n); return n; };
  if (kind === 'checklist') {
    const items = [];
    for (let i = 0; i < raw.length; i++) {
      const r = typeof raw[i] === 'string' ? { label: raw[i] } : (raw[i] || {});
      const label = String(r.label || '').trim().slice(0, 120);
      if (!label) return { error: 'Every checklist step needs a description' };
      items.push({ key: keyFor(r, i), label, required: r.required !== false });
    }
    return { schema: { kind, name, items } };
  }
  const fields = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] || {}; const label = String(r.label || '').trim().slice(0, 80);
    if (!label) return { error: 'Every field needs a label' };
    if (!FIELD_TYPES.includes(r.type)) return { error: `"${label}" has an unknown type` };
    const f = { key: keyFor(r, i), label, type: r.type, required: r.required === true };
    if (r.type === 'number') {
      if (r.unit) f.unit = String(r.unit).trim().slice(0, 12);
      if (Array.isArray(r.units) && r.units.length) { f.units = [...new Set(r.units.map(u => String(u).trim().slice(0, 12)).filter(Boolean))].slice(0, 6); if (f.units.length) f.unit = f.units[0]; }
      const lo = r.min === '' || r.min == null ? null : Number(r.min), hi = r.max === '' || r.max == null ? null : Number(r.max);
      if ((lo != null && !Number.isFinite(lo)) || (hi != null && !Number.isFinite(hi))) return { error: `"${label}": the expected range must be numbers` };
      if (lo != null && hi != null && lo > hi) return { error: `"${label}": the lowest value is above the highest` };
      if (lo != null) f.min = lo; if (hi != null) f.max = hi;
    }
    if (r.type === 'choice') {
      const opts = [...new Set((Array.isArray(r.options) ? r.options : []).map(o => String(o).trim().slice(0, 60)).filter(Boolean))];
      if (opts.length < 2 || opts.length > 20) return { error: `"${label}" needs between 2 and 20 choices` };
      f.options = opts;
    }
    fields.push(f);
  }
  return { schema: { kind, name, fields } };
}

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Checks the answers against the form. Returns { data } (cleaned) or { error } naming the first problem. */
function validateAnswers(schema, input) {
  if (!schema || typeof schema !== 'object') return { error: 'This task has no result form' };
  const d = input && typeof input === 'object' ? input : {};
  if (schema.kind === 'checklist') {
    const ticked = d.items && typeof d.items === 'object' ? d.items : {};
    const items = {};
    for (const it of schema.items) {
      items[it.key] = ticked[it.key] === true;
      if (it.required && !items[it.key]) return { error: `Tick "${it.label}" when it is done` };
    }
    const note = String(d.note == null ? '' : d.note).trim().slice(0, MAX_RESULT_LENGTH);
    return { data: { items, note } };
  }
  const out = {}; let any = false;
  for (const f of schema.fields) {
    const v = d[f.key];
    if (blank(v)) { if (f.required) return { error: `${f.label} is required` }; continue; }
    if (f.type === 'text') { const s = String(v).trim(); if (s.length > 500) return { error: `${f.label} is too long (at most 500 characters)` }; out[f.key] = s; }
    else if (f.type === 'longtext') { const s = String(v).trim(); if (s.length > MAX_RESULT_LENGTH) return { error: `${f.label} is too long (at most ${MAX_RESULT_LENGTH} characters)` }; out[f.key] = s; }
    else if (f.type === 'number') {
      const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
      if (!Number.isFinite(n) || Math.abs(n) > 1e9) return { error: `${f.label} must be a number` };
      out[f.key] = n;
      if (f.units) { const u = d[f.key + '_unit'] == null || d[f.key + '_unit'] === '' ? f.units[0] : String(d[f.key + '_unit']); if (!f.units.includes(u)) return { error: `${f.label}: choose one of ${f.units.join(', ')}` }; out[f.key + '_unit'] = u; }
    }
    else if (f.type === 'date') { if (!isValidDate(String(v))) return { error: `${f.label} must be a valid date` }; out[f.key] = String(v); }
    else if (f.type === 'choice') { if (!f.options.includes(String(v))) return { error: `${f.label}: choose one of the options` }; out[f.key] = String(v); }
    else if (f.type === 'yesno') { const y = v === true || v === 'yes' ? 'yes' : v === false || v === 'no' ? 'no' : null; if (!y) return { error: `${f.label}: answer yes or no` }; out[f.key] = y; }
    any = true;
  }
  if (!any) return { error: 'Fill in the form before handing it in' };
  return { data: out };
}

/** For number fields with an expected range: 'within', 'below' or 'above'. An out-of-range answer is allowed (it is information). */
function rangeFlags(schema, data) {
  const flags = {};
  if (!schema || schema.kind === 'checklist' || !data) return flags;
  for (const f of schema.fields || []) {
    if (f.type !== 'number' || (f.min == null && f.max == null) || !isNum(data[f.key])) continue;
    flags[f.key] = f.min != null && data[f.key] < f.min ? 'below' : f.max != null && data[f.key] > f.max ? 'above' : 'within';
  }
  return flags;
}

const rangeText = (f) => f.min != null && f.max != null ? `${f.min} to ${f.max}` : f.min != null ? `at least ${f.min}` : `at most ${f.max}`;
/** A readable version of the answers. It is stored as the task's result text, so every existing screen can show it. */
function summarise(schema, data) {
  if (schema.kind === 'checklist') {
    const lines = schema.items.map(it => `${data.items[it.key] ? '[x]' : '[ ]'} ${it.label}`);
    if (data.note) lines.push('Note: ' + data.note);
    return lines.join('\n').slice(0, MAX_RESULT_LENGTH);
  }
  const flags = rangeFlags(schema, data); const lines = [];
  for (const f of schema.fields) {
    if (data[f.key] === undefined) continue;
    let v = f.type === 'yesno' ? (data[f.key] === 'yes' ? 'Yes' : 'No') : f.type === 'date' ? dmy(data[f.key]) : String(data[f.key]);
    if (f.type === 'number') { const u = data[f.key + '_unit'] || f.unit; if (u) v += ' ' + u; if (flags[f.key] && flags[f.key] !== 'within') v += ` (outside the expected ${rangeText(f)})`; }
    lines.push(`${f.label}: ${v}`);
  }
  return lines.join('\n').slice(0, MAX_RESULT_LENGTH);
}

module.exports = {
  FIELD_TYPES, MAX_FORM_FIELDS, FORM_TEMPLATES, validateSchema, validateAnswers, rangeFlags, summarise,
  PROJECT_TYPES, PRODUCT_CATEGORIES, BASE_SYSTEMS, PRIORITIES, DEPARTMENTS, STATUSES, FEASIBILITY, COST_BASES,
  ACTIVE_STATUSES, CLOSED_STATUSES, HOLD_STATUS, scopeOfStatus, DEFAULT_PERFORMANCE_ROWS, STAGES, LAB_STAGE_NO, STAGE_COOLDOWN_SECONDS,
  APPROVAL_KINDS, APPROVAL_DECISIONS, APPROVAL_LABELS, stageDays, needsResult, NO_RESULT_LABELS, MAX_RESULT_LENGTH, MIN_TASK_RESULT_LENGTH,
  isValidDate, addDays, daysBetween, maxDate, todayIST, dmy,
  formatProjectNumber, periodOf, numberFor, parseProjectNumber,
  currentStageNo, autoPlan, findConflicts, delayDays, replanPreview,
  cleanRequirementRows, validateRequest
};
