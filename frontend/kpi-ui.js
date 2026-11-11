// Shared drawing code for the performance pages. Nothing here makes up a number: it only shows what /api/kpi returns.
// Colour is never the only signal: every band also has a word and a symbol.
const KPI_BANDS = { green: { word: 'On target', sym: '✓' }, amber: { word: 'Watch', sym: '!' }, red: { word: 'Below target', sym: '✕' } };
const kEl = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const kPlural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const kPct = (v) => (v == null ? '-' : (Number.isInteger(v) ? v : v.toFixed(1)) + '%');

function kpiChip(band) {
  if (!band) return kEl('span', 'kpi-chip none', 'No data');
  const b = KPI_BANDS[band]; const c = kEl('span', 'kpi-chip ' + band); c.append(kEl('b', null, b.sym), document.createTextNode(' ' + b.word)); return c;
}
/** One measured number: the value, the counts behind it, its band, and a warning when there are too few items to mean much. */
function kpiCell(value, sub, band, few) {
  const d = kEl('div', 'kpi-cell'); d.appendChild(kEl('strong', null, value));
  if (sub) d.appendChild(kEl('span', 'kpi-sub', sub));
  if (band !== undefined) d.appendChild(kpiChip(band));
  if (few) { const f = kEl('span', 'kpi-few', 'few items'); f.title = 'Fewer items than are needed for this percentage to mean much'; d.appendChild(f); }
  return d;
}
function kpiDays(v, label) { return v == null ? '-' : v + ' day' + (v === 1 ? '' : 's') + (label ? ' ' + label : ''); }

/** Six months of on-time rate as small bars, with the counts as text so it can be read without seeing the chart. */
function kpiTrend(trend) {
  const box = kEl('div', 'kpi-trend'); const max = Math.max(1, ...trend.map(t => t.completed));
  const svgNS = 'http://www.w3.org/2000/svg'; const w = 300, h = 90, bw = 36, gap = (w - bw * trend.length) / (trend.length + 1);
  const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + (h + 24)); svg.setAttribute('role', 'img'); svg.setAttribute('class', 'kpi-trendsvg');
  svg.setAttribute('aria-label', 'Tasks completed per month: ' + trend.map(t => t.month + ' ' + t.completed + (t.on_time_rate != null ? ' (' + t.on_time_rate + '% on time)' : '')).join(', '));
  trend.forEach((t, i) => {
    const x = gap + i * (bw + gap), bh = Math.max(t.completed ? 4 : 0, Math.round(t.completed / max * h));
    const rect = document.createElementNS(svgNS, 'rect'); rect.setAttribute('x', x); rect.setAttribute('y', h - bh); rect.setAttribute('width', bw); rect.setAttribute('height', bh); rect.setAttribute('rx', 4);
    rect.setAttribute('class', 'kpi-bar ' + (t.on_time_rate == null ? 'none' : t.on_time_rate >= 90 ? 'green' : t.on_time_rate >= 70 ? 'amber' : 'red')); svg.appendChild(rect);
    const n = document.createElementNS(svgNS, 'text'); n.setAttribute('x', x + bw / 2); n.setAttribute('y', Math.max(10, h - bh - 4)); n.setAttribute('text-anchor', 'middle'); n.setAttribute('class', 'kpi-num'); n.textContent = t.completed || ''; svg.appendChild(n);
    const m = document.createElementNS(svgNS, 'text'); m.setAttribute('x', x + bw / 2); m.setAttribute('y', h + 16); m.setAttribute('text-anchor', 'middle'); m.setAttribute('class', 'kpi-mon'); m.textContent = t.month.slice(5) + '/' + t.month.slice(2, 4); svg.appendChild(m);
  });
  box.appendChild(svg);
  const dl = kEl('details'); dl.appendChild(kEl('summary', null, 'Month by month as a list'));
  const ul = kEl('ul'); trend.forEach(t => ul.appendChild(kEl('li', null, t.month + ': ' + kPlural(t.completed, 'task') + ' completed' + (t.with_due ? ', ' + t.on_time + ' of ' + t.with_due + ' on time (' + t.on_time_rate + '%)' : ''))));
  dl.appendChild(ul); box.appendChild(dl); return box;
}

/** The person's tasks: finished ones with how late, and what is still open. */
function kpiTasks(tasks, today) {
  if (!tasks.length) return kEl('p', 'kpi-empty', 'No tasks in this period.');
  const t = kEl('table', 'kpi-tasks'); t.innerHTML = '<thead><tr><th scope="col">Task</th><th scope="col">Due</th><th scope="col">Status</th><th scope="col">Sent back</th></tr></thead>';
  const tb = kEl('tbody');
  tasks.forEach(x => {
    const tr = kEl('tr'); const c0 = kEl('td'); const a = kEl('a', null, x.title); a.href = 'project.html?id=' + x.project_id + '#list'; c0.appendChild(a); c0.appendChild(kEl('small', null, x.project_number)); c0.lastChild.style.display = 'block';
    const late = x.status === 'done' ? (x.days_late > 0 ? x.days_late + ' days late' : x.days_late != null ? 'On time' : 'Done') : (x.due_date && x.due_date < today ? 'Overdue' : 'Open');
    const st = kEl('td'); st.appendChild(kEl('span', 'kpi-state ' + (/late|Overdue/.test(late) ? 'bad' : x.status === 'done' ? 'ok' : ''), (x.status === 'in_review' ? 'In review' : x.status === 'done' ? late : late + (x.status === 'blocked' ? ', blocked' : ''))));
    tr.append(c0, kEl('td', null, x.due_date ? dmy(x.due_date) : '-'), st, kEl('td', null, x.sent_back ? String(x.sent_back) : '-')); tb.appendChild(tr);
  });
  t.appendChild(tb); const wrap = kEl('div', 'oxi-table-scroll'); wrap.appendChild(t); return wrap;
}

/** The plain-words explanation shown on both pages, so nobody has to guess what a number means. */
function kpiExplain() {
  const d = kEl('details', 'kpi-explain'); d.appendChild(kEl('summary', null, 'How these numbers are measured'));
  const ul = kEl('ul');
  [
    'Only work recorded in the app counts, and only work the person did themselves. A task someone else closed for them is not theirs.',
    'On time: tasks finished on or before the due date, out of those that had a due date. The person who assigned the task sets the due date.',
    'Overdue now: open tasks (to do, in progress or blocked) that are past their due date today. Work waiting for review is not counted as late.',
    'Right first time: work that was accepted without ever being sent back, out of the work accepted in the period. It only applies to work that is reviewed.',
    'Stages on time: stages the person owns (or leads when no owner is named) that were finished on or before their planned date.',
    'Review speed: for people who review, the average days between work being handed in and being accepted or sent back.',
    'A percentage with "few items" beside it is based on too few items to mean much. Look at the counts, not only the percentage.',
    'There is no overall score and nobody is ranked. Numbers do not show how hard the work was. Use them to start a conversation.'
  ].forEach(t => ul.appendChild(kEl('li', null, t)));
  d.appendChild(ul); return d;
}

/** Period choice: presets and custom dates. onChange({from,to}) is called when it changes. */
function kpiPeriod(onChange) {
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const add = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const first = (d) => d.slice(0, 8) + '01';
  const prevMonthEnd = add(first(today), -1);
  const presets = {
    last30: ['Last 30 days', () => [add(today, -29), today]], thismonth: ['This month', () => [first(today), today]], lastmonth: ['Last month', () => [first(prevMonthEnd), prevMonthEnd]],
    last90: ['Last 90 days', () => [add(today, -89), today]], custom: ['Custom dates...', null]
  };
  const wrap = kEl('div', 'kpi-period'); const sel = kEl('select'); sel.setAttribute('aria-label', 'Period');
  Object.entries(presets).forEach(([k, v]) => { const o = kEl('option', null, v[0]); o.value = k; sel.appendChild(o); });
  const from = kEl('input'); from.type = 'date'; from.setAttribute('aria-label', 'From'); const to = kEl('input'); to.type = 'date'; to.setAttribute('aria-label', 'To'); from.hidden = to.hidden = true;
  const read = () => { if (sel.value !== 'custom') { const [f, t] = presets[sel.value][1](); from.value = f; to.value = t; } return { from: from.value, to: to.value }; };
  const fire = () => { const r = read(); if (r.from && r.to) onChange(r); };
  sel.onchange = () => { from.hidden = to.hidden = sel.value !== 'custom'; fire(); }; from.onchange = to.onchange = () => { if (sel.value === 'custom') fire(); };
  wrap.append(sel, from, to); wrap.read = read; return wrap;
}
