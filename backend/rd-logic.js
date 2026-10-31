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

module.exports = {
  PROJECT_TYPES, PRODUCT_CATEGORIES, BASE_SYSTEMS, PRIORITIES, DEPARTMENTS, STATUSES, FEASIBILITY, COST_BASES,
  ACTIVE_STATUSES, CLOSED_STATUSES, HOLD_STATUS, scopeOfStatus, DEFAULT_PERFORMANCE_ROWS, STAGES, LAB_STAGE_NO, STAGE_COOLDOWN_SECONDS,
  APPROVAL_KINDS, APPROVAL_DECISIONS, APPROVAL_LABELS, stageDays,
  isValidDate, addDays, daysBetween, maxDate, todayIST, dmy,
  formatProjectNumber, periodOf, numberFor, parseProjectNumber,
  currentStageNo, autoPlan, findConflicts, delayDays, replanPreview,
  cleanRequirementRows, validateRequest
};
