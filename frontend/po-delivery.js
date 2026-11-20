// po-delivery.js - the two small forms for a purchase order's delivery: change the expected date, enter or update the dispatch (tracking) details.
// Used by the purchase order page and by Expected Deliveries. The server does the real checking (who may, which dates, the reason).
//
//   oxiPoDelivery.dateDialog(po, onSaved)       po: { id, po_date, delivery_date }
//   oxiPoDelivery.dispatchDialog(po, onSaved)   po: { id, status, transporter, tracking_number, vehicle_number, dispatch_date, tracking_url }
// onSaved() runs after a successful save. Dates may be "2026-11-25" or a full timestamp: only the first 10 characters are used.
(function () {
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const d10 = (v) => (v ? String(v).slice(0, 10) : '');

  function form(title, build, okText, submit, onSaved) {
    const dlg = mk('dialog', 'oxi-dlg'); dlg.setAttribute('aria-labelledby', 'dlgT'); const f = mk('form'); f.method = 'dialog'; f.style.display = 'grid'; f.style.gap = '10px';
    const h = mk('h3', null, title); h.id = 'dlgT'; f.appendChild(h); const read = build(f);
    const err = mk('div', 'oxi-errtext'); err.setAttribute('role', 'alert'); err.hidden = true; const row = mk('div', 'row');
    const no = mk('button', 'oxi-btn-secondary', 'Cancel'); no.type = 'button'; no.onclick = () => dlg.close(); const ok = mk('button', null, okText); ok.type = 'submit'; row.append(no, ok); f.append(err, row); dlg.appendChild(f); document.body.appendChild(dlg);
    const back = document.activeElement;
    f.onsubmit = async (e) => {
      e.preventDefault(); err.hidden = true; ok.disabled = true; const r = await submit(read()); ok.disabled = false;
      if (!r.success) { err.textContent = r.error || 'Could not save.'; err.hidden = false; return; }
      dlg.close(); if (onSaved) await onSaved(r);
    };
    dlg.addEventListener('close', () => { dlg.remove(); if (back && document.contains(back)) back.focus(); });
    dlg.showModal(); const first = dlg.querySelector('input, textarea, select'); if (first) first.focus(); return dlg;
  }
  const lab = (f, text, input, id, hint) => { const l = mk('label', null, text); l.htmlFor = id; input.id = id; f.append(l, input); if (hint) f.appendChild(mk('small', 'oxi-section-note', hint)); };

  function dateDialog(po, onSaved) {
    return form(po.delivery_date ? 'Change the expected delivery date' : 'Set the expected delivery date', (f) => {
      const d = mk('input'); d.type = 'date'; d.value = d10(po.delivery_date); if (po.po_date) d.min = d10(po.po_date); lab(f, 'Expected delivery date', d, 'dlvDate');
      const r = mk('textarea'); r.rows = 2; r.maxLength = 300; lab(f, po.delivery_date ? 'Why is it changing? (needed)' : 'Note (optional)', r, 'dlvWhy', po.delivery_date ? 'For example: supplier said 3 days late.' : '');
      return () => ({ delivery_date: d.value, reason: r.value });
    }, 'Save date', (v) => api('/api/po/' + po.id + '/delivery-date', 'PUT', v), onSaved);
  }

  function dispatchDialog(po, onSaved) {
    const had = !!(po.tracking_number || po.vehicle_number || po.transporter);
    return form(had ? 'Update the dispatch details' : 'Enter the dispatch details', (f) => {
      const t = mk('input'); t.type = 'text'; t.maxLength = 100; t.value = po.transporter || ''; lab(f, 'Transporter or courier', t, 'dlvTr', "For example: VRL Logistics, DTDC, the supplier's own vehicle");
      const n = mk('input'); n.type = 'text'; n.maxLength = 80; n.value = po.tracking_number || ''; lab(f, 'Tracking number or LR number', n, 'dlvNo');
      const v = mk('input'); v.type = 'text'; v.maxLength = 30; v.value = po.vehicle_number || ''; lab(f, 'Vehicle number', v, 'dlvVeh');
      const dd = mk('input'); dd.type = 'date'; dd.value = d10(po.dispatch_date); dd.max = new Date().toISOString().slice(0, 10); lab(f, 'Dispatch date', dd, 'dlvDisp');
      const u = mk('input'); u.type = 'url'; u.maxLength = 300; u.value = po.tracking_url || ''; u.placeholder = 'https://'; lab(f, 'Tracking link (optional)', u, 'dlvUrl', 'A web address starting with https:// that opens the tracking page.');
      let why = null; if (had) { why = mk('textarea'); why.rows = 2; why.maxLength = 300; lab(f, 'Why are the details changing? (needed)', why, 'dlvWhy2'); }
      let ck = null;
      if (po.status === 'payment_done') { const cl = mk('label'); cl.style.cssText = 'display:flex;gap:8px;align-items:center;font-weight:400'; ck = mk('input'); ck.type = 'checkbox'; ck.style.cssText = 'width:20px;height:20px'; cl.append(ck, mk('span', null, 'Also mark this order as In transit')); f.appendChild(cl); }
      return () => ({ transporter: t.value, tracking_number: n.value, vehicle_number: v.value, dispatch_date: dd.value, tracking_url: u.value, reason: why ? why.value : '', mark_in_transit: ck ? ck.checked : false });
    }, 'Save', (v) => api('/api/po/' + po.id + '/dispatch', 'PUT', v), onSaved);
  }

  window.oxiPoDelivery = { dateDialog, dispatchDialog };
})();
