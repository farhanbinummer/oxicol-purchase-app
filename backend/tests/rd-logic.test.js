// Unit tests for the R&D rules that need no database: numbering, dates, scheduling, forms.
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../rd-logic');

const stages = (over = {}) => R.STAGES.map(s => ({ no: s.no, days: s.days, planned: null, actual: null, ...(over[s.no] || {}) }));

test('project numbers: OXRD + serial + month + year, never truncated', () => {
  assert.equal(R.formatProjectNumber(1, 10, 26), 'OXRD011026');
  assert.equal(R.numberFor(1, '2026-10-31'), 'OXRD011026');
  assert.equal(R.numberFor(7, '2027-01-05'), 'OXRD070127');
  assert.equal(R.numberFor(99, '2026-12-01'), 'OXRD991226');
  assert.equal(R.numberFor(100, '2026-12-01'), 'OXRD1001226', 'a third digit is kept, not cut');
  assert.equal(R.numberFor(1234, '2026-02-01'), 'OXRD123402' + '26');
  assert.deepEqual(R.parseProjectNumber('OXRD011026'), { serial: 1, month: 10, year2: 26, period: '2610' });
  assert.equal(R.parseProjectNumber('OXRD1001226').serial, 100, 'the month and year are always the last four digits');
  assert.equal(R.parseProjectNumber('OXRD011326'), null, 'month 13 is not a number');
  assert.equal(R.parseProjectNumber('XYZ011026'), null);
  assert.equal(R.periodOf('2026-10-31'), '2610');
});

test('dates are strings and never shift with a time zone', () => {
  assert.equal(R.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(R.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(R.addDays('2028-02-28', 1), '2028-02-29', 'leap day');
  assert.equal(R.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(R.daysBetween('2026-10-01', '2026-10-31'), 30);
  assert.equal(R.daysBetween('2026-10-31', '2026-10-01'), -30);
  assert.equal(R.dmy('2026-10-31'), '31-10-2026');
  assert.equal(R.isValidDate('2026-02-30'), false);
  assert.equal(R.isValidDate('2026-10-31'), true);
  assert.equal(R.isValidDate('31-10-2026'), false);
  // 20:00 UTC on 31 Oct is already 01:30 on 1 Nov in India
  assert.equal(R.todayIST(Date.UTC(2026, 9, 31, 20, 0)), '2026-11-01');
  assert.equal(R.todayIST(Date.UTC(2026, 9, 31, 18, 29)), '2026-10-31');
  assert.equal(R.todayIST(Date.UTC(2026, 9, 31, 18, 30)), '2026-11-01');
});

test('there are eight stages in order with the specified durations and checklists', () => {
  assert.equal(R.STAGES.length, 8);
  assert.deepEqual(R.STAGES.map(s => s.no), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(R.STAGES.map(s => s.days), [7, 5, 21, 14, 3, 14, 7, 5]);
  assert.ok(R.STAGES.every(s => s.checklist.length === 3));
  assert.equal(R.stageDays(R.STAGES[2], 30), 30, 'stage 3 follows the estimated trial duration');
  assert.equal(R.stageDays(R.STAGES[2], null), 21);
  assert.equal(R.stageDays(R.STAGES[0], 30), 7, 'only stage 3 uses it');
  assert.deepEqual(R.STAGES.filter(s => s.needs).map(s => [s.no, s.needs]), [[4, 'qc_signoff'], [6, 'customer'], [8, 'handover_ack']]);
});

test('active, paused and closed statuses are defined once', () => {
  assert.equal(R.scopeOfStatus('In Lab Trials'), 'active');
  assert.equal(R.scopeOfStatus('On Hold'), 'hold', 'on hold is paused, not completed and not active');
  assert.equal(R.scopeOfStatus('Completed'), 'closed');
  assert.equal(R.scopeOfStatus('Rejected'), 'closed');
  assert.equal(R.STATUSES.length, 9);
});

test('auto-plan fills only empty dates, starts from today or the latest earlier date, and keeps what was entered', () => {
  const p = R.autoPlan(stages(), '2026-11-02');
  assert.deepEqual(p.map(x => x.planned), ['2026-11-09', '2026-11-14', '2026-12-05', '2026-12-19', '2026-12-22', '2027-01-05', '2027-01-12', '2027-01-17']);

  // a date somebody entered is an anchor and is never overwritten
  const manual = R.autoPlan(stages({ 1: { planned: '2026-11-20' } }), '2026-11-02');
  assert.equal(manual.find(x => x.no === 1), undefined, 'stage 1 is untouched');
  assert.equal(manual.find(x => x.no === 2).planned, '2026-11-25', 'stage 2 starts from the entered stage-1 date');

  // a completed stage anchors later ones (later than today)
  const done = R.autoPlan(stages({ 1: { planned: '2026-11-05', actual: '2026-11-20' } }), '2026-11-10');
  assert.equal(done.find(x => x.no === 2).planned, '2026-11-25');

  // when everything is in the past, planning starts from today
  const past = R.autoPlan(stages({ 1: { planned: '2026-01-01', actual: '2026-01-05' } }), '2026-11-10');
  assert.equal(past.find(x => x.no === 2).planned, '2026-11-15');

  // an existing later date is kept even when earlier ones are filled
  const gap = R.autoPlan(stages({ 3: { planned: '2026-12-31' } }), '2026-11-02');
  assert.deepEqual(gap.map(x => x.no), [1, 2, 4, 5, 6, 7, 8]);
  assert.equal(gap.find(x => x.no === 4).planned, '2027-01-14');
});

test('conflicts: stages out of order and a finish after the launch target', () => {
  assert.deepEqual(R.findConflicts(R.autoPlan(stages(), '2026-11-02').reduce((a, p) => { a[p.no - 1].planned = p.planned; return a; }, stages()), '2027-06-30'), []);
  const out = stages({ 1: { planned: '2026-12-10' }, 2: { planned: '2026-12-01' } });
  const c = R.findConflicts(out, null);
  assert.equal(c.length, 1); assert.equal(c[0].type, 'order'); assert.equal(c[0].stage, 2);
  const late = stages({ 8: { planned: '2027-03-01' } });
  const l = R.findConflicts(late, '2027-01-31');
  assert.equal(l.find(x => x.type === 'launch').stage, 8);
  assert.deepEqual(R.findConflicts(late, null), [], 'no target, no launch conflict');
});

test('delay: completed = actual - planned; pending and overdue = today - planned', () => {
  assert.equal(R.delayDays({ planned: '2026-10-10', actual: '2026-10-15' }, '2026-11-01'), 5);
  assert.equal(R.delayDays({ planned: '2026-10-10', actual: '2026-10-08' }, '2026-11-01'), -2, 'early is shown as early');
  assert.equal(R.delayDays({ planned: '2026-10-10', actual: null }, '2026-10-14'), 4);
  assert.equal(R.delayDays({ planned: '2026-10-10', actual: null }, '2026-10-10'), null, 'due today is not late');
  assert.equal(R.delayDays({ planned: null, actual: null }, '2026-10-14'), null);
  assert.equal(R.currentStageNo(stages({ 1: { actual: '2026-10-01' }, 2: { actual: '2026-10-02' } })), 3);
  assert.equal(R.currentStageNo(stages(Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map(n => [n, { actual: '2026-10-01' }])))), null);
});

test('a changed trial duration is previewed, never applied silently', () => {
  const base = stages({ 1: { actual: '2026-11-01', planned: '2026-11-01' }, 2: { actual: '2026-11-05', planned: '2026-11-06' }, 3: { planned: '2026-11-27' }, 4: { planned: '2026-12-11' } });
  const withLonger = base.map(s => (s.no === 3 ? { ...s, days: 40 } : s));
  const prev = R.replanPreview(withLonger, '2026-11-06', 3);
  assert.equal(prev[0].no, 3); assert.equal(prev[0].current, '2026-11-27'); assert.equal(prev[0].proposed, '2026-12-16');
  assert.ok(prev.every(p => p.no >= 3), 'completed stages are not part of the preview');
  assert.equal(base[2].planned, '2026-11-27', 'the input is untouched');
});

test('request rows: empty rows are dropped, cells are trimmed', () => {
  const rows = R.cleanRequirementRows([
    { parameter: ' Viscosity ', target: '60-80 KU' }, { parameter: '', target: '  ' }, {}, null, { remarks: 'only a remark' }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].parameter, 'Viscosity'); assert.equal(rows[0].test_method, '');
  assert.equal(R.DEFAULT_PERFORMANCE_ROWS.length, 8);
});

test('submitting needs the required fields; a draft only needs a title', () => {
  assert.deepEqual(R.validateRequest({ title: 'x' }, false), []);
  assert.equal(R.validateRequest({ title: '' }, false).length, 1);
  const bad = R.validateRequest({ title: 'x' }, true).map(e => e.field);
  ['project_type', 'department', 'priority', 'product_category', 'base_system', 'description', 'target_launch_date'].forEach(f => assert.ok(bad.includes(f), f));
  const ok = { title: 'x', project_type: R.PROJECT_TYPES[0], department: 'QC', priority: 'High', product_category: R.PRODUCT_CATEGORIES[0], base_system: 'Water-based', description: 'd', target_tbc: true };
  assert.deepEqual(R.validateRequest(ok, true), []);
  assert.equal(R.validateRequest({ ...ok, priority: 'Urgent' }, true)[0].field, 'priority');
  assert.deepEqual(R.validateRequest({ ...ok, target_tbc: false, target_launch_date: '2027-01-01' }, true), []);
});
