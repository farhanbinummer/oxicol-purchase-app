// admin-remove.js - the careful "remove permanently" box, shared by the Remove Data page and by the record pages (administrators only).
//
//   oxiRemoveDialog({ kind, words, rows: [{ id, number, title, counts, blocked }], onDone })   opens the box for these records
//   oxiAdminRemove({ kind, id, mount, listHref })                                              adds a "remove this record" card for an administrator
// The server does the real checking (administrator only, typed confirmation, reason, all-or-nothing, audit entry); this is only the box.
(function () {
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const countsText = (c) => Object.entries(c || {}).map(([k, v]) => v + ' ' + k.toLowerCase()).join(', ') || 'nothing else under it';

  window.oxiRemoveDialog = function (o) {
    const rows = o.rows, many = rows.length > 1;
    const expected = many ? 'DELETE ' + rows.length + ' ' + o.words.toUpperCase() : (rows[0].number || 'DELETE');
    const dlg = mk('dialog', 'oxi-dlg'); dlg.setAttribute('aria-labelledby', 'rmdT'); const f = mk('form'); f.method = 'dialog';
    const h = mk('h3', null, 'Remove ' + (many ? rows.length + ' ' + o.words : (rows[0].number || rows[0].title)) + ' permanently?'); h.id = 'rmdT'; f.appendChild(h);
    f.appendChild(mk('p', 'oxi-warn-box', 'This cannot be undone. Everything listed under it goes with it. If this is real data, take a database backup first.'));
    const ul = mk('ul', 'oxi-rm-list'); rows.slice(0, 12).forEach(r => ul.appendChild(mk('li', null, (r.number ? r.number + ' ' : '') + (r.title || '') + ': ' + countsText(r.counts)))); if (rows.length > 12) ul.appendChild(mk('li', null, '...and ' + (rows.length - 12) + ' more')); f.appendChild(ul);
    const l1 = mk('label', null, 'Type  ' + expected + '  to confirm'); l1.htmlFor = 'rmdType'; const typed = mk('input'); typed.type = 'text'; typed.id = 'rmdType'; typed.autocomplete = 'off'; f.append(l1, typed);
    const l2 = mk('label', null, 'Why are you removing this? (kept in the Audit History)'); l2.htmlFor = 'rmdWhy'; l2.style.cssText = 'display:block;margin-top:10px'; const why = mk('textarea'); why.id = 'rmdWhy'; why.rows = 2; why.maxLength = 1000; f.append(l2, why);
    const err = mk('div', 'oxi-errtext'); err.setAttribute('role', 'alert'); err.hidden = true; const row = mk('div', 'row');
    const no = mk('button', 'oxi-btn-secondary', 'Cancel'); no.type = 'button'; no.onclick = () => dlg.close(); const ok = mk('button', 'oxi-danger', 'Remove permanently'); ok.type = 'submit'; row.append(no, ok); f.append(err, row); dlg.appendChild(f); document.body.appendChild(dlg);
    const back = document.activeElement;
    f.onsubmit = async (e) => {
      e.preventDefault(); err.hidden = true;
      if (typed.value.trim() !== expected) { err.textContent = 'Please type exactly: ' + expected; err.hidden = false; typed.focus(); return; }
      if (why.value.trim().length < 5) { err.textContent = 'Please write why (at least 5 letters).'; err.hidden = false; why.focus(); return; }
      ok.disabled = true; const r = await api('/api/admin/data/records/' + o.kind + '/delete', 'POST', { ids: rows.map(x => x.id), confirm: typed.value.trim(), reason: why.value });
      if (!r.success) { ok.disabled = false; err.textContent = r.error || 'Could not remove.'; err.hidden = false; return; }
      dlg.close(); if (o.onDone) o.onDone(r);
    };
    dlg.addEventListener('close', () => { dlg.remove(); if (back && document.contains(back)) back.focus(); }); dlg.showModal(); typed.focus();
  };

  window.oxiAdminRemove = async function (o) {
    const me = window.oxiMe && window.oxiMe(); let admin = me ? !!me.is_admin : null;
    if (admin == null) { const r = await api('/api/workspace/me'); admin = !!(r && r.success && r.is_admin); }      // not remembered yet on this device
    if (!admin) return;
    const box = mk('section', 'oxi-card2'); box.setAttribute('aria-label', 'Administrator: remove'); box.style.marginTop = '24px';
    box.append(mk('h3', null, 'Administrator: remove this record'), mk('p', 'oxi-section-note', 'Removes it permanently, with everything under it. Only for test data or mistakes. It is recorded in the Audit History.'));
    const b = mk('button', 'oxi-danger', 'Remove this record...'); b.type = 'button';
    b.onclick = async () => {
      const d = await api('/api/admin/data/records/' + o.kind + '?id=' + encodeURIComponent(o.id)); if (!d.success || !d.rows.length) { alert(d.error || 'Could not load this record.'); return; }
      if (d.rows[0].blocked) { alert('This cannot be removed yet. ' + d.rows[0].blocked); return; }
      window.oxiRemoveDialog({ kind: o.kind, words: d.words, rows: d.rows, onDone: () => { location.href = o.listHref; } });
    };
    box.appendChild(b); o.mount.appendChild(box);
  };
})();
