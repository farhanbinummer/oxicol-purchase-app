// common.js - small helpers + the app shell (sidebar/topbar) shared by every page.
// Include this near the TOP of <body> on every page: it wires up login and must run
// before any other script makes an /api/... call.

// ---------- dark mode: applied immediately, before the page paints, to avoid a flash ----------
(function () {
  const saved = localStorage.getItem('oxicol_theme');
  const theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
})();

// Lets phones offer "Install app" / build an APK; sw.js only passes requests through to the network.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// Small inline icon set (no external font/CDN, so the app still looks right with no internet).
const OXI_ICONS = {
  dashboard: '<path d="M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6V11h-6v9zm0-16v5h6V4h-6z"/>',
  branch: '<path d="M3 21h18M6 21V9l6-5 6 5v12M9 21v-6h6v6"/>',
  production: '<path d="M9 3h6M10 3v5l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
  consolidate: '<path d="M4 6h6l2 3h8M4 12h6l2 3h8M4 18h16"/>',
  po: '<path d="M7 3h8l4 4v14H7zM15 3v4h4M9 12h8M9 16h8M9 8h3"/>',
  payment: '<path d="M3 7h18v10H3zM3 10h18M7 15h3"/>',
  grn: '<path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/>',
  variance: '<path d="M12 3l10 18H2zM12 10v4M12 17h.01"/>',
  users: '<path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c0-4 3-6 7-6s7 2 7 6M17 11a4 4 0 0 0 0-8M23 21c0-3-2-5-5-6"/>',
  search: '<path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9zM13.7 21a2 2 0 0 1-3.4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  sun: '<path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/><circle cx="12" cy="12" r="4"/>',
  user: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-7 8-7s8 3 8 7"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4"/>'
};
function svgIcon(name, size) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + (size || 18) + '" height="' + (size || 18) +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" class="oxi-icon">' + (OXI_ICONS[name] || '') + '</svg>';
}

(function () {
  const PUBLIC_PAGES = ['login.html'];
  const page = location.pathname.split('/').pop() || 'index.html';
  const token = localStorage.getItem('oxicol_token');

  if (!token && !PUBLIC_PAGES.includes(page)) {
    location.href = 'login.html';
    return; // don't bother patching fetch etc. on a page we're leaving
  }

  // Every fetch("/api/...") on every page gets the login token attached automatically,
  // and a 401 (session expired/missing) bounces back to the login page.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    init = init || {};
    if (url.startsWith('/api/') && token) {
      init.headers = Object.assign({}, init.headers, { Authorization: 'Bearer ' + token });
    }
    const res = await realFetch(input, init);
    if (res.status === 401 && url.startsWith('/api/')) {
      localStorage.removeItem('oxicol_token');
      localStorage.removeItem('oxicol_user');
      location.href = 'login.html';
    }
    return res;
  };

  // Sidebar links. roles:'*' shows to everyone; admin always sees all.
  const NAV_LINKS = [
    { label: 'Dashboard', href: 'index.html', roles: '*', icon: 'dashboard' },
    { label: 'Branch Requests', href: 'branch-request-list.html', roles: 'branch,store', icon: 'branch' },
    { label: 'Production Indents', href: 'production-indent-list.html', roles: 'production,store', icon: 'production' },
    { label: 'Consolidate', href: 'consolidate.html', roles: 'purchase', icon: 'consolidate' },
    { label: 'Purchase Orders', href: 'po-list.html', roles: 'store,purchase,accounts', icon: 'po' },
    { label: 'Payments', href: 'payment-list.html', roles: 'purchase,accounts', icon: 'payment' },
    { label: 'GRNs', href: 'grn-list.html', roles: 'store,purchase,accounts', icon: 'grn' },
    { label: 'Variance Report', href: 'variance-report.html', roles: 'store,purchase,accounts', icon: 'variance' },
    { label: 'Users', href: 'users.html', roles: 'admin', icon: 'users' },
    { label: 'Permissions', href: 'permissions.html', roles: 'admin', icon: 'shield' }
  ];

  // "+ New" quick-create menu, role-aware (same idea as the sidebar).
  const CREATE_LINKS = [
    { label: 'Branch Stock Request', href: 'branch-request-form.html', roles: 'branch' },
    { label: 'Production Indent', href: 'production-indent-form.html', roles: 'production' },
    { label: 'Purchase Order', href: 'po-form.html', roles: 'purchase' },
    { label: 'Payment', href: 'payment-form.html', roles: 'accounts' },
    { label: 'GRN', href: 'grn-form.html', roles: 'store' }
  ];

  function allowedFor(user, roles) {
    return roles === '*' || user.role === 'admin' || roles.split(',').includes(user.role);
  }

  // Builds the sidebar + top bar shell around whatever the page already put in <body>.
  document.addEventListener('DOMContentLoaded', () => {
    if (PUBLIC_PAGES.includes(page)) return;
    let user = null;
    try { user = JSON.parse(localStorage.getItem('oxicol_user') || 'null'); } catch (e) {}
    if (!user) return;

    // Move everything the page already rendered into the large rounded white main panel.
    const content = document.createElement('div');
    content.className = 'oxi-content';
    const panel = document.createElement('div');
    panel.className = 'oxi-main-panel';
    while (document.body.firstChild) panel.appendChild(document.body.firstChild);
    content.appendChild(panel);

    // ---------- sidebar: slim, icon-only circular buttons ----------
    const sidebar = document.createElement('aside');
    sidebar.className = 'oxi-sidebar';
    sidebar.innerHTML =
      '<a href="index.html" class="oxi-brand-mark" title="Oxicol - Dashboard">' +
        '<span class="oxi-brand-icon">O</span><span class="oxi-nav-label">Oxicol</span>' +
      '</a>' +
      '<nav class="oxi-sidenav"></nav>' +
      '<button class="oxi-theme-toggle" id="oxiThemeToggle" title="Toggle dark mode"></button>';
    const sidenav = sidebar.querySelector('.oxi-sidenav');
    NAV_LINKS.forEach(item => {
      if (!allowedFor(user, item.roles)) return;
      const a = document.createElement('a');
      a.href = item.href;
      a.title = item.label;
      a.innerHTML = svgIcon(item.icon, 19) + '<span class="oxi-nav-label">' + item.label + '</span>';
      if (page === item.href) a.className = 'active';
      sidenav.appendChild(a);
    });

    // ---------- top bar ----------
    const topbar = document.createElement('header');
    topbar.className = 'oxi-topbar';
    const companyLabel = 'Oxicol Car Care Products' + (user.branch ? ' &middot; ' + user.branch : '');
    topbar.innerHTML =
      '<button class="oxi-icon-btn oxi-menu-btn" id="oxiMenuBtn" title="Menu">' + svgIcon('menu') + '</button>' +
      '<div class="oxi-company-label" title="Malappuram, Kerala">' + svgIcon('branch', 15) + '<span>' + companyLabel + '</span></div>' +
      '<div class="oxi-search">' + svgIcon('search') +
        '<input id="oxiSearch" placeholder="Search PO, supplier, GRN, invoice, or payment..." autocomplete="off">' +
        '<div class="oxi-search-results" id="oxiSearchResults" hidden></div>' +
      '</div>' +
      '<div class="oxi-spacer"></div>' +
      '<button class="oxi-icon-btn" id="oxiPrintBtn" title="Print this page">' + svgIcon('print') + '</button>' +
      '<div class="oxi-dropdown" id="oxiNotifWrap"></div>' +
      '<div class="oxi-dropdown" id="oxiCreateWrap"></div>' +
      '<div class="oxi-dropdown" id="oxiProfileWrap"></div>';
    document.body.append(sidebar, topbar, content);
    document.body.classList.add('oxi-shell');
    document.getElementById('oxiPrintBtn').onclick = () => window.print();

    // ---------- notifications: real pending items this role can act on, not a fake counter ----------
    const notifWrap = document.getElementById('oxiNotifWrap');
    const notifBtn = document.createElement('button');
    notifBtn.className = 'oxi-icon-btn'; notifBtn.title = 'Notifications';
    notifBtn.innerHTML = svgIcon('bell') + '<span class="oxi-notif-dot" id="oxiNotifDot" hidden></span>';
    const notifMenu = document.createElement('div');
    notifMenu.className = 'oxi-menu oxi-notif-menu'; notifMenu.hidden = true;
    notifMenu.innerHTML = '<div class="oxi-menu-title">Notifications</div><div id="oxiNotifList" class="oxi-empty">Loading...</div>';
    notifBtn.onclick = (e) => { e.stopPropagation(); notifMenu.hidden = !notifMenu.hidden; };
    notifWrap.append(notifBtn, notifMenu);

    (async () => {
      const items = [];
      if (['branch', 'store', 'admin'].includes(user.role)) {
        const d = await api('/api/branch-request?status=pending');
        if (d.success) d.requests.forEach(r => items.push({ label: r.request_number + ' - ' + r.branch + ' needs approval', href: 'branch-request-list.html' }));
      }
      if (['production', 'store', 'admin'].includes(user.role)) {
        const d = await api('/api/production-indent?status=pending');
        if (d.success) d.indents.forEach(r => items.push({ label: r.indent_number + ' needs approval', href: 'production-indent-list.html' }));
      }
      if (['store', 'admin'].includes(user.role)) {
        const d = await api('/api/grn?discrepancies=false');
        if (d.success) d.grns.filter(g => g.status === 'pending_qc').forEach(g => items.push({ label: 'GRN ' + g.grn_number + ' needs QC decision', href: 'grn-detail.html?id=' + g.id }));
      }
      if (['accounts', 'admin'].includes(user.role)) {
        const d = await api('/api/payment');
        if (d.success) d.payments.filter(p => p.status === 'initiated').forEach(p => items.push({ label: 'Payment ' + p.payment_id + ' needs confirmation', href: 'payment-list.html' }));
      }
      const list = document.getElementById('oxiNotifList');
      if (items.length === 0) { list.textContent = 'Nothing needs your attention right now.'; return; }
      document.getElementById('oxiNotifDot').hidden = false;
      list.className = ''; list.innerHTML = '';
      items.slice(0, 8).forEach(i => {
        const a = document.createElement('a'); a.href = i.href; a.textContent = i.label;
        list.appendChild(a);
      });
    })();

    // ---------- "+ New" quick-create dropdown ----------
    const creates = CREATE_LINKS.filter(c => allowedFor(user, c.roles));
    const createWrap = document.getElementById('oxiCreateWrap');
    if (creates.length) {
      const btn = document.createElement('button');
      btn.className = 'oxi-btn-primary-sm';
      btn.innerHTML = svgIcon('plus', 16) + '<span>New</span>';
      const menu = document.createElement('div');
      menu.className = 'oxi-menu';
      menu.hidden = true;
      creates.forEach(c => {
        const a = document.createElement('a');
        a.href = c.href; a.textContent = c.label;
        menu.appendChild(a);
      });
      btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
      createWrap.append(btn, menu);
    }

    // ---------- profile dropdown ----------
    const profWrap = document.getElementById('oxiProfileWrap');
    const profBtn = document.createElement('button');
    profBtn.className = 'oxi-profile-btn';
    profBtn.innerHTML = svgIcon('user', 20) +
      '<span class="oxi-profile-text">' + user.name + '<small>' + user.role + (user.branch ? ', ' + user.branch : '') + '</small></span>' +
      svgIcon('chevron', 14);
    const profMenu = document.createElement('div');
    profMenu.className = 'oxi-menu';
    profMenu.hidden = true;
    profMenu.innerHTML = '<a href="account.html">My Account</a>';
    const logoutBtn = document.createElement('a');
    logoutBtn.href = '#';
    logoutBtn.textContent = 'Logout';
    logoutBtn.onclick = async (e) => {
      e.preventDefault();
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (err) {}
      localStorage.removeItem('oxicol_token');
      localStorage.removeItem('oxicol_user');
      location.href = 'login.html';
    };
    profMenu.appendChild(logoutBtn);
    profBtn.onclick = (e) => { e.stopPropagation(); profMenu.hidden = !profMenu.hidden; };
    profWrap.append(profBtn, profMenu);

    // ---------- mobile: collapsed search pill expands to a full-width bar on tap ----------
    const searchWrap = topbar.querySelector('.oxi-search');
    searchWrap.addEventListener('click', (e) => {
      if (window.innerWidth > 640 || searchWrap.classList.contains('oxi-search-active')) return;
      e.stopPropagation();
      searchWrap.classList.add('oxi-search-active');
      document.getElementById('oxiSearch').focus();
    });

    // ---------- mobile sidebar toggle ----------
    const menuBtn = document.getElementById('oxiMenuBtn');
    menuBtn.onclick = () => document.body.classList.toggle('oxi-sidebar-open');

    document.addEventListener('click', (e) => {
      profMenu.hidden = true;
      notifMenu.hidden = true;
      const cm = createWrap.querySelector('.oxi-menu'); if (cm) cm.hidden = true;
      searchWrap.classList.remove('oxi-search-active');
      // Tapping anywhere outside the open mobile drawer closes it (it has no X button by design).
      if (!sidebar.contains(e.target) && !menuBtn.contains(e.target)) {
        document.body.classList.remove('oxi-sidebar-open');
      }
    });

    // ---------- dark mode toggle ----------
    const themeBtn = document.getElementById('oxiThemeToggle');
    function paintThemeBtn() {
      const t = document.documentElement.getAttribute('data-theme');
      themeBtn.innerHTML = svgIcon(t === 'dark' ? 'sun' : 'moon', 16) + '<span class="oxi-nav-label">' + (t === 'dark' ? 'Light mode' : 'Dark mode') + '</span>';
    }
    paintThemeBtn();
    themeBtn.onclick = () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('oxicol_theme', next);
      paintThemeBtn();
    };

    // ---------- search ----------
    const searchInput = document.getElementById('oxiSearch');
    const searchResults = document.getElementById('oxiSearchResults');
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = searchInput.value.trim();
      if (q.length < 2) { searchResults.hidden = true; return; }
      searchTimer = setTimeout(async () => {
        const d = await api('/api/search?q=' + encodeURIComponent(q));
        searchResults.innerHTML = '';
        if (d.success && d.results.length) {
          d.results.forEach(r => {
            const a = document.createElement('a');
            a.href = r.href;
            a.innerHTML = '<small>' + r.type + '</small>' + r.label;
            searchResults.appendChild(a);
          });
        } else {
          searchResults.innerHTML = '<div class="oxi-search-empty">No matches</div>';
        }
        searchResults.hidden = false;
      }, 250);
    });
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { searchResults.hidden = true; });
  });
})();

// Returns a colored <span class="badge"> for a status word, so lists read at a glance.
// Unrecognised words fall back to a plain neutral pill rather than looking broken.
function badge(status) {
  const s = document.createElement('span');
  const text = String(status || '-');
  const GOOD = ['approved', 'confirmed', 'delivered', 'matched', 'good', 'active', 'closed', 'payment_done', 'posted_to_tally', 'yes'];
  const BAD = ['rejected', 'damaged', 'short', 'mismatch', 'variance', 'failed', 'disabled', 'variance_flagged', 'no'];
  const WARN = ['pending', 'pending_qc', 'initiated', 'created', 'payment_pending', 'in_transit', 'uploaded'];
  const key = text.toLowerCase();
  const cls = GOOD.includes(key) ? 'badge-good' : BAD.includes(key) ? 'badge-bad'
            : WARN.includes(key) ? 'badge-warn' : 'badge-neutral';
  s.className = 'badge ' + cls;
  s.textContent = text;
  return s;
}

// Adds a table cell holding a status badge (see badge() above).
function addBadge(tr, status) {
  const td = document.createElement('td');
  td.appendChild(badge(status));
  tr.appendChild(td);
  return td;
}

// 1234.5 -> "1,234.50"
function money(n) {
  return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "2026-09-21T..." -> "2026-09-21"; empty -> "-"
function day(v) {
  return v ? String(v).slice(0, 10) : '-';
}

// Today's date as YYYY-MM-DD in the browser's local time.
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Shows a green (ok) or red (error) message in <p id="message">.
function show(text, ok) {
  const m = document.getElementById('message');
  m.textContent = text;
  m.className = ok ? 'success' : 'error';
  window.scrollTo(0, 0);
}

// Calls the API and returns the JSON. Never throws for HTTP errors (the JSON has success:false).
async function api(url, method, body) {
  const opts = { method: method || 'GET', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  try {
    const r = await fetch(url, opts);
    return await r.json();
  } catch (e) {
    return { success: false, error: 'Could not reach the server. Is it running?' };
  }
}

// "2026-09-20T10:00:00Z" -> "2 hours ago" / "3 days ago". Falls back to the date if very old.
function timeAgo(dateStr) {
  if (!dateStr) return '-';
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.floor(hours / 24);
  if (days < 14) return days + (days === 1 ? ' day ago' : ' days ago');
  return day(dateStr);
}

// A shimmering placeholder block shown while data is still loading, instead of "Loading...".
function skeletonBlock(height) {
  const div = document.createElement('div');
  div.className = 'oxi-skeleton';
  div.style.height = (height || 16) + 'px';
  return div;
}
function skeletonRows(container, count, height) {
  container.innerHTML = '';
  for (let i = 0; i < (count || 3); i++) container.appendChild(skeletonBlock(height));
}

// A friendly "nothing here" panel: icon + message + optional action link.
function emptyState(message, actionLabel, actionHref) {
  const div = document.createElement('div');
  div.className = 'oxi-empty-state';
  div.innerHTML = svgIcon('search', 28) + '<p>' + message + '</p>';
  if (actionLabel && actionHref) {
    const a = document.createElement('a');
    a.href = actionHref; a.textContent = actionLabel; a.className = 'oxi-btn-primary-sm';
    div.appendChild(a);
  }
  return div;
}

// Adds a table cell with plain text (textContent, so data can never inject HTML).
function addCell(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
  return td;
}

// Wires up a search box and/or status dropdown/chips to filter an already-rendered table.
// Call this AFTER the rows are in the DOM. Each data row should have tr.dataset.status
// set (e.g. tr.dataset.status = po.status) for the status filter to work.
// opts.chipsId: a container of <button class="oxi-chip" data-value="..."> (one with data-value=""
// for "All") - clicking one filters to that status and highlights it as active.
function attachListFilter(opts) {
  const tbody = document.getElementById(opts.tbodyId);
  const searchEl = opts.searchId && document.getElementById(opts.searchId);
  const statusEl = opts.statusId && document.getElementById(opts.statusId);
  const chipsEl = opts.chipsId && document.getElementById(opts.chipsId);
  let chipValue = '';
  function apply() {
    const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
    const st = statusEl ? statusEl.value : chipsEl ? chipValue : '';
    [...tbody.rows].forEach(tr => {
      if (!tr.dataset.status && tr.cells.length === 1) return; // "Loading.../No X yet" placeholder row
      const matchesSearch = !q || tr.textContent.toLowerCase().includes(q);
      const matchesStatus = !st || tr.dataset.status === st;
      tr.style.display = (matchesSearch && matchesStatus) ? '' : 'none';
    });
  }
  if (searchEl) searchEl.addEventListener('input', apply);
  if (statusEl) statusEl.addEventListener('change', apply);
  if (chipsEl) {
    chipsEl.querySelectorAll('.oxi-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chipsEl.querySelectorAll('.oxi-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        chipValue = chip.dataset.value || '';
        apply();
      });
    });
  }
  return apply;
}

// Adds a table cell holding a link.
function addLink(tr, text, href) {
  const td = document.createElement('td');
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  td.appendChild(a);
  tr.appendChild(td);
  return td;
}

// ---------- phone card layout for list tables ----------
// On a phone each table row becomes a card (see "table.oxi-rowcards" in styles.css). Rows are
// filled in after the page loads, so this labels every cell from its column header
// and re-labels whenever the rows change.
(function () {
  const CARD_PAGES = ['branch-request-list.html', 'production-indent-list.html', 'po-list.html',
    'payment-list.html', 'grn-list.html', 'users.html', 'variance-report.html'];
  const page = location.pathname.split('/').pop() || 'index.html';
  if (!CARD_PAGES.includes(page)) return;

  function decorate() {
    document.querySelectorAll('table').forEach(table => {
      const heads = table.querySelectorAll('thead th');
      if (!heads.length || table.style.width === 'auto') return;
      table.classList.add('oxi-rowcards');
      table.querySelectorAll('tbody tr').forEach(tr => {
        [...tr.children].forEach((td, i) => {
          if (td.colSpan > 1) { td.classList.add('oxi-card-full'); return; }
          const label = heads[i] ? heads[i].textContent.trim() : '';
          if (td.dataset.label !== label) td.dataset.label = label;
          if (!label) td.classList.add('oxi-card-action');
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    decorate();
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; decorate(); });
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
