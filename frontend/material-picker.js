// material-picker.js - "type a few letters, choose the raw material". Used on the purchase order and production request forms.
//
//   oxiMaterialPicker(input, { onPick(material) })
//
// The server searches (GET /api/catalog/materials/search) and only SUGGESTS; the person chooses. A chosen material's id is kept on the
// input as input.dataset.materialId (forms send it as material_id) and its name is put in the box. Anything typed that is not on the list
// still works (it is saved as typed) and is marked so the person knows. Keyboard: Down/Up to move, Enter to choose, Esc to close.
(function () {
  let seqId = 0, current = null;                       // the picker whose list is open
  const dd = document.createElement('div'); dd.className = 'oxi-ac'; dd.setAttribute('role', 'listbox'); dd.hidden = true; dd.id = 'oxiMatList';

  function place() {
    if (dd.hidden || !current) return;
    const r = current.input.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) { close(); return; }
    dd.style.left = Math.max(8, r.left) + 'px'; dd.style.width = Math.min(Math.max(r.width, 300), window.innerWidth - 16) + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 240 && r.top > below) { dd.style.top = 'auto'; dd.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { dd.style.bottom = 'auto'; dd.style.top = (r.bottom + 4) + 'px'; }
  }
  function close() { dd.hidden = true; if (current) { current.input.setAttribute('aria-expanded', 'false'); current.input.removeAttribute('aria-activedescendant'); } current = null; }
  function setActive(p, i) {
    p.idx = i; const opts = [...dd.querySelectorAll('[role=option]')];
    opts.forEach((o, k) => { o.classList.toggle('active', k === i); o.setAttribute('aria-selected', String(k === i)); });
    if (opts[i]) { opts[i].scrollIntoView({ block: 'nearest' }); p.input.setAttribute('aria-activedescendant', opts[i].id); } else p.input.removeAttribute('aria-activedescendant');
  }
  function hint(p, text) {
    let h = p.input.parentNode.querySelector('.oxi-ac-hint');
    if (!h) { h = document.createElement('small'); h.className = 'oxi-ac-hint'; p.input.parentNode.appendChild(h); }
    h.textContent = text || '';
  }
  function choose(p, m) {
    p.input.value = m.name; p.input.dataset.materialId = m.id; hint(p, ''); close();
    if (p.opts.onPick) p.opts.onPick(m);
  }
  function paint(p, list, q) {
    if (dd.parentNode !== document.body) document.body.appendChild(dd);
    p.list = list; p.stale = false; dd.innerHTML = '';
    if (!list.length) { const n = document.createElement('div'); n.className = 'oxi-ac-none'; n.textContent = q ? 'Not on the raw material list. You can still use what you typed.' : 'Start typing a material name or code'; dd.appendChild(n); }
    list.forEach((m, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'option'); b.id = 'oxiMat' + i; b.setAttribute('aria-selected', 'false');
      const name = document.createElement('span'); name.textContent = m.name;
      const meta = document.createElement('small'); meta.style.cssText = 'display:block;color:var(--text-muted)';
      meta.textContent = [m.code, m.unit || 'unit not set', m.hsn_code ? 'HSN ' + m.hsn_code : ''].filter(Boolean).join(' - ');
      b.append(name, meta); b.addEventListener('pointerdown', (e) => e.preventDefault()); b.addEventListener('click', () => choose(p, m)); dd.appendChild(b);
    });
    current = p; p.input.setAttribute('aria-expanded', 'true'); dd.hidden = false; setActive(p, -1); place();
  }
  async function search(p) {
    const seq = ++p.seq, q = p.input.value.trim();
    let d; try { d = await api('/api/catalog/materials/search?limit=10&q=' + encodeURIComponent(q)); } catch (e) { return; }
    if (seq !== p.seq || document.activeElement !== p.input) return;      // a newer keystroke, or the person moved on
    if (d && d.success) paint(p, d.materials, q);
  }

  window.oxiMaterialPicker = function (input, opts) {
    const p = { input, opts: opts || {}, seq: 0, list: [], idx: -1, timer: null, stale: false };
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', 'oxiMatList'); input.autocomplete = 'off';
    if (!input.placeholder) input.placeholder = 'Type to search raw materials';
    input.addEventListener('input', () => { delete input.dataset.materialId; hint(p, ''); p.stale = true; p.idx = -1; input.removeAttribute('aria-activedescendant'); dd.querySelectorAll('[role=option]').forEach(o => { o.classList.remove('active'); o.setAttribute('aria-selected', 'false'); }); clearTimeout(p.timer); p.timer = setTimeout(() => search(p), 150); });
    input.addEventListener('focus', () => search(p));
    input.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement === input) return;
      if (current === p) close();
      if (input.value.trim() && !input.dataset.materialId) hint(p, 'Not from the list: saved as typed');
    }, 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();                  // Enter chooses a suggestion; it must never send the whole form
      if (dd.hidden || current !== p) { if (e.key === 'ArrowDown') { search(p); } return; }
      const n = p.stale ? 0 : p.list.length;                    // while new results are loading, the old list cannot be chosen from
      if (e.key === 'ArrowDown') { e.preventDefault(); if (n) setActive(p, (p.idx + 1) % n); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setActive(p, (p.idx - 1 + n) % n); }
      else if (e.key === 'Enter' && p.idx >= 0 && !p.stale) { choose(p, p.list[p.idx]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place);
    return p;
  };
})();
