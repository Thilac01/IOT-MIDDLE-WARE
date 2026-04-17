/**
 * app.js — JPL Security Monitor Frontend
 * Handles: WebSocket, SPA navigation, REST API calls,
 *          live event stream, whitelist CRUD, alerts.
 */

const API_BASE = window.location.origin + '/api/v1';
const WS_URL   = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';

// ── Firebase Config ──────────────────────────────────────────────────────────
// REPLACE WITH YOUR ACTUAL FIREBASE CONFIG
const firebaseConfig = {
  apiKey: "AIzaSyDw81zSl-xVYImiwqKWIAEHjv3AU8ssUgA",
  authDomain: "auth-ce82b.firebaseapp.com",
  projectId: "auth-ce82b",
  storageBucket: "auth-ce82b.firebasestorage.app",
  messagingSenderId: "929307470038",
  appId: "1:929307470038:web:ecbca53eed7ca2e7cec177",
  measurementId: "G-HK5MG643J0"
};
firebase.initializeApp(firebaseConfig);
const fbAuth = firebase.auth();
firebase.analytics();

// ── State ─────────────────────────────────────────────────────────────────────
let socket             = null;
let reconnectTimer     = null;
let sessionEventCount  = 0;
let unackedAlertCount  = 0;
let currentTable       = null;
let currentPage        = 1;
let searchDebounce     = null;
let allTableNames      = [];
let currentDeviceId    = null;
let currentDeviceIp    = null;
let authToken          = 'bypassed'; 
let currentUser        = { username: 'Administrator', role: 'admin' };
let xterm              = null;
let fitAddon           = null;

// ── DOM Helper ──────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function setHTML(id, html) {
  const el = $(id);
  if (el) el.innerHTML = html;
  else console.warn(`Element #${id} not found for innerHTML`);
}
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
  else console.warn(`Element #${id} not found for textContent`);
}
function setDisplay(id, display) {
  const el = $(id);
  if (el) el.style.display = display;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1.  NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  
  const v = $('view-' + name);
  const n = $('nav-' + name);
  if (v) v.classList.add('active');
  if (n) n.classList.add('active');

  // Lazy-load on first visit
  if (name === 'tables' && allTableNames.length === 0) loadTableList();
  if (name === 'whitelist') loadWhitelist();
  if (name === 'alerts') loadAlerts();
  if (name === 'devices') loadDevices();
  if (name === 'audit') {
    loadAuditLogs();
    loadKohaActionLogs();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 2.  WEBSOCKET
// ══════════════════════════════════════════════════════════════════════════════
function connectWS() {
  updateWSStatus('connecting');
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    updateWSStatus('connected');
    clearTimeout(reconnectTimer);
    // Keep-alive ping every 25s
    setInterval(() => { if (socket.readyState === 1) socket.send('ping'); }, 25000);
    showToast('Connected', 'Real-time data stream active', 'success');
  };

  socket.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    handleWSMessage(msg);
  };

  socket.onerror = () => updateWSStatus('disconnected');

  socket.onclose = () => {
    updateWSStatus('disconnected');
    showToast('Disconnected', 'Reconnecting in 5 s…', 'warning');
    reconnectTimer = setTimeout(connectWS, 5000);
  };
}

function updateWSStatus(state) {
  const el  = document.getElementById('ws-indicator');
  const lbl = document.getElementById('ws-label');
  el.className = 'ws-status ' + state;
  const labels = { connecting: 'Connecting…', connected: 'Connected', disconnected: 'Reconnecting…' };
  lbl.textContent = labels[state] || state;
  document.getElementById('kpi-ws-val').textContent =
    state === 'connected' ? 'LIVE' : state === 'disconnected' ? 'OFFLINE' : '…';
}

// ── Route incoming WS messages ────────────────────────────────────────────────
function handleWSMessage(msg) {
  switch (msg.type) {
    case 'live_row':
      handleLiveRow(msg.data);
      break;
    case 'security_alert':
      handleSecurityAlert(msg.data);
      break;
    case 'book_event':
      handleBookEvent(msg.data);
      break;
    case 'whitelist_update':
      handleWhitelistUpdate(msg.data);
      break;
    case 'device_update':
      if (document.getElementById('view-devices').classList.contains('active')) {
        loadDevices();
      }
      break;
    case 'terminal_output':
      handleTerminalOutput(msg.data);
      break;
    case 'pong':
      break; // keep-alive reply
  }
}

function handleTerminalOutput(data) {
  if (currentDeviceId !== data.device_id) return;
  if (xterm) {
    const text = typeof data.output === 'string' ? data.output : '';
    xterm.write(text);

    // Detect if connection succeeded
    if (text.includes("Successfully connected to")) {
        setDisplay('ssh-login-overlay', 'none');
        const termInput = $('term-input');
        if (termInput) {
          termInput.disabled = false;
          setTimeout(() => termInput.focus(), 100);
        }
        
        setTimeout(() => {
          const curlCmd = `nohup bash -c "API_IP=\\$(echo \\$SSH_CLIENT | awk '{print \\$1}'); while true; do curl -s -X POST http://\\$API_IP:8000/api/v1/devices/${currentDeviceId}/heartbeat -H 'Content-Type: application/json' -d '{}'; sleep 15; done" >/dev/null 2>&1 &`;
          sendTerminalCommand(curlCmd + "\\r\\nclear\\r\\n");
        }, 1200);
    } else if (text.includes("SSH Connection Failed")) {
        setTimeout(() => {
          xterm.write("\\r\\n[Press Close to exit and try again]\\r\\n");
          setDisplay('ssh-login-overlay', 'none');
        }, 500);
    }
  }
}

function handleLiveRow(data) {
  sessionEventCount++;
  setText('kpi-events-val', sessionEventCount);
  
  // For the live stream, we only want to show check-ins and check-outs clearly
  if (data.table === 'issues' || data.table === 'old_issues') {
    const action = data.table === 'issues' ? 'CHECKOUT' : 'CHECKIN';
    addStreamRow(action, data.table, data.row, false);
    loadCirculation(); // Refresh the side-by-side tables too
  } else {
    // For other tables, just a generic row update but keep it subtle
    addStreamRow(data.event, data.table, data.row, false);
  }

  // If the live table viewer is showing this table, highlight new row
  if (currentTable === data.table) {
    refreshTable();
  }
}

function handleSecurityAlert(data) {
  unackedAlertCount++;
  updateAlertBadge();
  refreshDashboardAlerts();
  setText('kpi-unacked-val', unackedAlertCount);
  showToast(
    '🚨 Security Alert',
    data.message || `Non-whitelisted barcode: ${data.barcode}`,
    'danger',
    8000
  );

  addStreamRow('ALERT', 'issues', { barcode: data.barcode, branch: data.branch_code }, true);
  refreshDashboardAlerts();

  // Update KPI
  setText('kpi-unacked-val', unackedAlertCount);
}

// ── Book Event High-Intensity Popup ───────────────────────────────────────────
function handleBookEvent(data) {
  const modal = $('book-alert-modal');
  const actionLabel = $('alert-action-label');
  const barcodeEl = $('alert-barcode');
  const borrowerEl = $('alert-borrower');
  const branchEl = $('alert-branch');
  const statusEl = $('alert-whitelist-status');
  const titleEl = $('book-alert-title');
  const card = document.querySelector('.book-alert-card');

  // Update Content
  actionLabel.textContent = data.action === 'CHECKOUT' ? 'SYSTEM CHECKOUT' : 'SYSTEM CHECKIN';
  barcodeEl.textContent = data.barcode || 'UNKNOWN';
  borrowerEl.textContent = data.borrower || '—';
  branchEl.textContent = data.branch || '—';

  // Add to Live Stream immediately
  addStreamRow(data.action, data.action === 'CHECKOUT' ? 'issues' : 'old_issues', {
    barcode: data.barcode,
    borrower: data.borrower,
    title: data.title || 'Processing...',
    branch: data.branch
  }, !data.whitelisted && data.action === 'CHECKOUT');

  // Whitelist Logic (Color coding)
...
  if (data.action === 'CHECKOUT') {
    if (data.whitelisted) {
      statusEl.textContent = '✓ WHITELISTED AUTHORIZATION';
      statusEl.className = 'whitelist-status valid';
      card.style.borderColor = 'var(--success)';
      titleEl.textContent = 'SECURE AUTHORIZATION';
    } else {
      statusEl.textContent = '⚠ NON-WHITELISTED DETECTED';
      statusEl.className = 'whitelist-status invalid';
      card.style.borderColor = 'var(--danger)';
      titleEl.textContent = 'SECURITY ALERT';
    }
  } else {
    // Check-in
    statusEl.textContent = 'ITEM RETURNED TO INVENTORY';
    statusEl.className = 'whitelist-status valid';
    card.style.borderColor = 'var(--info)';
    titleEl.textContent = 'INVENTORY UPDATE';
  }

  // Show Modal with sound
  modal.style.display = 'flex';
  
  // Refresh circulation mini-tables
  loadCirculation();

  // Auto-close after 10s if not acked
  setTimeout(() => {
    if (modal.style.display === 'flex') closeBookAlert();
  }, 10000);
}

function closeBookAlert() {
  const modal = $('book-alert-modal');
  modal.style.opacity = '0';
  setTimeout(() => {
    modal.style.display = 'none';
    modal.style.opacity = '1';
  }, 300);
}

function handleWhitelistUpdate(data) {
  showToast('Whitelist Updated', `Action: ${data.action} — ${data.barcode || '#' + data.id}`, 'info');
  // Refresh if on whitelist view
  if (document.getElementById('view-whitelist').classList.contains('active')) {
    loadWhitelist();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 3.  STREAM ROW
// ══════════════════════════════════════════════════════════════════════════════
function addStreamRow(event, table, row, isAlert, timestamp = null) {
  const container = document.getElementById('event-stream');
  if (!container) return;
  const empty = container.querySelector('.stream-empty');
  if (empty) empty.remove();

  const ts = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
  const badgeClass = isAlert ? 'badge-alert' : { 
    INSERT: 'badge-insert', 
    UPDATE: 'badge-update', 
    DELETE: 'badge-delete', 
    AUDIT: 'badge-audit',
    CHECKOUT: 'badge-checkout',
    CHECKIN: 'badge-checkin'
  }[event] || 'badge-insert';
  
  let detail = '';
  if (isAlert) {
    detail = `<strong>🚨 SECURITY ALERT</strong> — Barcode: <code>${row.barcode}</code> ${row.title ? `| Book: <em>${row.title}</em>` : ''}`;
  } else if (event === 'CHECKOUT') {
    detail = `📖 <strong>Checkout:</strong> <em>${row.title || 'Book #'+(row.barcode||'')}</em> by <code>${row.borrower || 'User'}</code>`;
  } else if (event === 'CHECKIN') {
    detail = `📥 <strong>Check-in:</strong> <em>${row.title || 'Book #'+(row.barcode||'')}</em> returned from <code>${row.borrower || 'User'}</code>`;
  } else if (event === 'AUDIT') {
    detail = `Audit Log: <strong>${row.action}</strong> by user <code>${row.user}</code>`;
  } else {
    detail = `Table: <strong>${table}</strong> &nbsp;${summariseRow(row)}`;
  }

  const div = document.createElement('div');
  div.className = 'stream-row' + (isAlert ? ' alert-row' : '') + (!timestamp ? ' new-entry' : '');
  div.innerHTML = `
    <span class="stream-ts">${ts}</span>
    <span class="stream-badge ${badgeClass}">${event}</span>
    <span class="stream-detail">${detail}</span>
  `;

  container.insertBefore(div, container.firstChild);

  // Keep last 100 rows
  while (container.children.length > 100) {
    container.removeChild(container.lastChild);
  }

  // If live (not history) and it's a security event, show alert popup
  if (!timestamp && isAlert) {
    showToast('🚨 SYSTEM SECURITY ALERT', detail, 'danger', 10000);
  }
}

function summariseRow(row) {
  if (!row) return '';
  const keys = Object.keys(row).slice(0, 4);
  return keys.map(k => `<span style="color:var(--text-muted)">${k}:</span> ${row[k]}`).join(' &nbsp;');
}

// ══════════════════════════════════════════════════════════════════════════════
// 4.  TOASTS
// ══════════════════════════════════════════════════════════════════════════════
function showToast(title, msg, type = 'info', duration = 4500) {
  const icons = {
    info:    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    success: '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
    warning: '<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    danger:  '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><polyline points="16 3 12 7 8 3"/></svg>',
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${msg}</div>
    </div>
  `;
  toast.onclick = () => removeToast(toast);
  document.getElementById('toast-container').appendChild(toast);
  setTimeout(() => removeToast(toast), duration);
}

function removeToast(toast) {
  toast.classList.add('removing');
  setTimeout(() => toast.remove(), 250);
}

// ══════════════════════════════════════════════════════════════════════════════
// 5.  DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
async function loadDashboard() {
  try {
    const [alertsRes, wlRes] = await Promise.all([
      apiFetch('/alerts/?unacknowledged_only=true&limit=5'),
      apiFetch('/whitelist/?active_only=true'),
    ]);
    unackedAlertCount = Array.isArray(alertsRes) ? alertsRes.length : 0;
    updateAlertBadge();
    setText('kpi-unacked-val', unackedAlertCount);
    setText('kpi-whitelist-val', Array.isArray(wlRes) ? wlRes.length : 0);
    renderDashboardAlerts(alertsRes);
    loadCirculation();
    loadStreamHistory(); // Fetch past events on dashboard load
  } catch (e) {
    console.warn('Dashboard load error:', e);
  }
}

/**
 * Fetches recent alerts and audit logs to populate the 'Live Event Stream'
 * with history on page load.
 */
async function loadStreamHistory() {
  const container = document.getElementById('event-stream');
  if (!container) return;

  try {
    // Fetch recent circulation instead of just alerts/audits
    const [outRes, inRes] = await Promise.all([
      apiFetch('/tables/circulation_active'),
      apiFetch('/tables/circulation_returns'),
    ]);

    const history = [];

    (outRes.rows || []).slice(0, 15).forEach(r => {
      history.push({
        ts: r.issuedate,
        event: 'CHECKOUT',
        table: 'issues',
        row: { title: r.title, borrower: r.borrower, barcode: r.barcode },
        isAlert: false
      });
    });

    (inRes.rows || []).slice(0, 15).forEach(r => {
      history.push({
        ts: r.returndate,
        event: 'CHECKIN',
        table: 'old_issues',
        row: { title: r.title, borrower: r.borrower, barcode: r.barcode },
        isAlert: false
      });
    });

    // Sort by timestamp descending
    history.sort((a, b) => new Date(b.ts) - new Date(a.ts));

    // Clear empty message
    const empty = container.querySelector('.stream-empty');
    if (empty && history.length > 0) empty.remove();

    // Add to stream
    history.reverse().forEach(h => {
      addStreamRow(h.event, h.table, h.row, h.isAlert, h.ts);
    });

  } catch (e) {
    console.warn('Stream history load error:', e);
  }
}

// ── Circulation Helpers ───────────────────────────────────────────────────────
async function loadCirculation() {
  const outBody = $('circ-out-body');
  const inBody = $('circ-in-body');
  
  try {
    const [outRes, inRes] = await Promise.all([
      apiFetch('/tables/circulation_active'),
      apiFetch('/tables/circulation_returns'),
    ]);
    renderCircOut(outRes.rows || []);
    renderCircIn(inRes.rows || []);
  } catch (e) {
    console.warn('Circulation load error:', e);
    const attemptedPath = '/tables/circulation_active';
    const fullUrl = API_BASE + attemptedPath;
    const errText = `Error: ${e.message || 'Unknown'} — Path: ${fullUrl}`;
    if (outBody) outBody.innerHTML = `<tr><td colspan="3" class="empty-cell" style="color:var(--danger)">${errText}</td></tr>`;
    if (inBody) inBody.innerHTML = `<tr><td colspan="3" class="empty-cell" style="color:var(--danger)">${errText}</td></tr>`;
  }
}

function renderCircOut(rows) {
  const tbody = $('circ-out-body');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-cell">No books out</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td title="${escHtml(r.title)}"><div style="font-weight:600;color:var(--text-primary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.title)}</div></td>
      <td style="font-size:11px">${escHtml(r.borrower)}</td>
      <td style="font-size:11px;color:var(--accent)">${fmtDate(r.date_due)}</td>
    </tr>
  `).join('');
}

function renderCircIn(rows) {
  const tbody = $('circ-in-body');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-cell">No recent returns</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td title="${escHtml(r.title)}"><div style="font-weight:600;color:var(--text-primary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.title)}</div></td>
      <td style="font-size:11px">${escHtml(r.borrower)}</td>
      <td style="font-size:11px;color:var(--info)">${fmtDate(r.returndate)}</td>
    </tr>
  `).join('');
}

function updateAlertBadge() {
  const badge = document.getElementById('alert-badge');
  badge.textContent = unackedAlertCount;
  badge.style.display = unackedAlertCount > 0 ? 'inline-block' : 'none';
}

async function refreshDashboardAlerts() {
  try {
    const data = await apiFetch('/alerts/?unacknowledged_only=true&limit=5');
    renderDashboardAlerts(data);
  } catch (_) {}
}

function renderDashboardAlerts(alerts) {
  const tbody = document.getElementById('dash-alerts-body');
  if (!tbody) return;
  
  if (!alerts || !alerts.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No alerts</td></tr>';
    return;
  }
  tbody.innerHTML = alerts.map(a => `
    <tr>
      <td>${fmtDate(a.detected_at)}</td>
      <td><span class="pill pill-danger">${a.alert_type}</span></td>
      <td><code style="font-family:var(--font-mono);font-size:11px">${a.barcode}</code></td>
      <td>${a.borrower_number || '—'}</td>
      <td>${a.branch_code || '—'}</td>
      <td>${a.acknowledged ? '<span class="pill pill-success">ACK</span>' : '<span class="pill pill-danger">OPEN</span>'}</td>
    </tr>
  `).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
// 6.  LIVE TABLE VIEWER
// ══════════════════════════════════════════════════════════════════════════════
async function loadTableList() {
  setHTML('table-list', '<div class="loading-placeholder">Loading…</div>');
  try {
    allTableNames = await apiFetch('/tables/');
    renderTableList(allTableNames);
  } catch (e) {
    setHTML('table-list', '<div class="loading-placeholder" style="color:var(--danger)">Failed to load tables</div>');
  }
}

function renderTableList(tables) {
  if (!Array.isArray(tables)) return;
  const html = tables.map(t => `
    <div class="table-list-item ${t === currentTable ? 'active' : ''}"
         id="tl-${t}"
         onclick="selectTable('${t}')">${t}</div>
  `).join('') || '<div class="loading-placeholder">No tables found</div>';
  setHTML('table-list', html);
}

function filterTableList(q) {
  const filtered = allTableNames.filter(t => t.toLowerCase().includes(q.toLowerCase()));
  renderTableList(filtered);
}

async function selectTable(name) {
  currentTable = name;
  currentPage  = 1;
  document.getElementById('table-panel-empty').style.display = 'none';
  document.getElementById('table-panel-content').style.display = 'flex';
  document.getElementById('panel-table-name').textContent = name;
  document.getElementById('table-row-search').value = '';
  // Update sidebar highlight
  document.querySelectorAll('.table-list-item').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('tl-' + name);
  if (el) el.classList.add('active');
  await fetchTableData();
}

async function fetchTableData(search = '') {
  setHTML('table-data-wrap', '<div class="loading-placeholder">Loading rows…</div>');
  try {
    const params = new URLSearchParams({
      page: currentPage,
      page_size: 50,
      ...(search ? { search } : {}),
    });
    const data = await apiFetch(`/tables/${currentTable}?${params}`);
    renderTableData(data);
  } catch (e) {
    setHTML('table-data-wrap', `<div class="loading-placeholder" style="color:var(--danger)">Error: ${e.message}</div>`);
  }
}

function renderTableData(data) {
  setText('table-meta', `${(data.total || 0).toLocaleString()} rows total • Page ${data.page} • ${data.columns.length} columns`);

  if (!data.rows || !data.rows.length) {
    setHTML('table-data-wrap', '<div class="loading-placeholder">No rows found</div>');
    setHTML('table-pagination', '');
    return;
  }

  const thead = `<thead><tr>${data.columns.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${data.rows.map(row =>
    `<tr>${data.columns.map(c => `<td title="${escHtml(row[c])}">${escHtml(row[c])}</td>`).join('')}</tr>`
  ).join('')}</tbody>`;

  setHTML('table-data-wrap', `<table class="data-table">${thead}${tbody}</table>`);
  renderPagination(data.total, data.page, data.page_size);
}

function renderPagination(total, page, size) {
  const totalPages = Math.ceil(total / size);
  const container = document.getElementById('table-pagination');
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  let pages = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) pages.push(i);

  container.innerHTML = `
    <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="gotoPage(${page - 1})">‹</button>
    ${pages.map(p => `<button class="page-btn ${p === page ? 'active' : ''}" onclick="gotoPage(${p})">${p}</button>`).join('')}
    <button class="page-btn" ${page >= totalPages ? 'disabled' : ''} onclick="gotoPage(${page + 1})">›</button>
  `;
}

function gotoPage(p) {
  currentPage = p;
  fetchTableData(document.getElementById('table-row-search').value);
}

function searchTable(q) {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    currentPage = 1;
    fetchTableData(q);
  }, 400);
}

function refreshTable() {
  if (currentTable) fetchTableData(document.getElementById('table-row-search').value);
}

// ══════════════════════════════════════════════════════════════════════════════
// 7.  WHITELIST CRUD
// ══════════════════════════════════════════════════════════════════════════════
async function loadWhitelist() {
  const tbody = document.getElementById('whitelist-body');
  const activeOnly = document.getElementById('wl-active-only').checked;
  tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">Loading…</td></tr>';
  try {
    const data = await apiFetch(`/whitelist/?active_only=${activeOnly}`);
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No books whitelisted yet</td></tr>';
      document.getElementById('kpi-whitelist-val').textContent = 0;
      return;
    }
    document.getElementById('kpi-whitelist-val').textContent = data.filter(d => d.is_active).length;
    tbody.innerHTML = data.map(item => `
      <tr id="wl-row-${item.id}">
        <td><code style="font-family:var(--font-mono);font-size:11px">${escHtml(item.barcode)}</code></td>
        <td>${escHtml(item.title)}</td>
        <td>${escHtml(item.author || '—')}</td>
        <td>${escHtml(item.isbn || '—')}</td>
        <td>${escHtml(item.added_by)}</td>
        <td style="max-width:160px">${escHtml(item.reason || '—')}</td>
        <td>${item.is_active ? '<span class="pill pill-success">Active</span>' : '<span class="pill pill-warning">Inactive</span>'}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="removeFromWhitelist(${item.id})">Remove</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-cell" style="color:var(--danger)">Error: ${e.message}</td></tr>`;
  }
}

async function addToWhitelist(evt) {
  evt.preventDefault();
  const btn = document.getElementById('wl-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Adding…';

  const body = {
    barcode:  document.getElementById('wl-barcode').value.trim(),
    isbn:     document.getElementById('wl-isbn').value.trim() || null,
    title:    document.getElementById('wl-title').value.trim(),
    author:   document.getElementById('wl-author').value.trim() || null,
    reason:   document.getElementById('wl-reason').value.trim() || null,
    added_by: 'admin',
  };

  try {
    await apiFetch('/whitelist/', { method: 'POST', body: JSON.stringify(body) });
    showToast('Whitelist Updated', `"${body.title}" added successfully`, 'success');
    document.getElementById('whitelist-form').reset();
    await loadWhitelist();
  } catch (e) {
    showToast('Error', e.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add to Whitelist';
  }
}

async function removeFromWhitelist(id) {
  if (!confirm('Remove this entry from whitelist?')) return;
  try {
    await apiFetch(`/whitelist/${id}`, { method: 'DELETE' });
    showToast('Removed', 'Book removed from whitelist (soft delete)', 'warning');
    loadWhitelist();
  } catch (e) {
    showToast('Error', e.message, 'danger');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 8.  ALERTS
// ══════════════════════════════════════════════════════════════════════════════
async function loadAlerts() {
  const tbody = document.getElementById('alerts-body');
  const unackedOnly = document.getElementById('alerts-unacked-only').checked;
  tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">Loading…</td></tr>';
  try {
    const data = await apiFetch(`/alerts/?unacknowledged_only=${unackedOnly}&limit=200`);
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No alerts found</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(a => `
      <tr id="alert-row-${a.id}">
        <td>${a.id}</td>
        <td style="font-family:var(--font-mono);font-size:11px">${fmtDate(a.detected_at)}</td>
        <td><span class="pill pill-danger">${a.alert_type}</span></td>
        <td><code style="font-family:var(--font-mono);font-size:11px">${escHtml(a.barcode)}</code></td>
        <td>${a.borrower_number || '—'}</td>
        <td>${escHtml(a.branch_code || '—')}</td>
        <td>${a.acknowledged
          ? `<span class="pill pill-success">ACK</span><br><span style="font-size:10px;color:var(--text-muted)">${escHtml(a.acknowledged_by || '')} ${fmtDate(a.acknowledged_at)}</span>`
          : '<span class="pill pill-danger">OPEN</span>'}</td>
        <td>
          ${!a.acknowledged
            ? `<button class="btn btn-sm btn-outline" onclick="acknowledgeAlert(${a.id})">Acknowledge</button>`
            : '—'}
        </td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-cell" style="color:var(--danger)">Error: ${e.message}</td></tr>`;
  }
}

async function acknowledgeAlert(id) {
  try {
    await apiFetch(`/alerts/${id}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ acknowledged_by: 'admin' }),
    });
    unackedAlertCount = Math.max(0, unackedAlertCount - 1);
    updateAlertBadge();
    document.getElementById('kpi-unacked-val').textContent = unackedAlertCount;
    showToast('Acknowledged', `Alert #${id} marked as resolved`, 'success');
    loadAlerts();
    refreshDashboardAlerts();
  } catch (e) {
    showToast('Error', e.message, 'danger');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 9.  UTILITIES & AUTHENTICATION
// ══════════════════════════════════════════════════════════════════════════════
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  
  const res = await fetch(API_BASE + path, { ...opts, headers });
  
  if (res.status === 401) {
    authLogout();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function checkAuth() {
  const overlay = document.getElementById('auth-overlay');
  const app = document.getElementById('app-container');

  // Verify "current user" is set
  const userDisplay = document.getElementById('nav-username');
  if (userDisplay) userDisplay.textContent = currentUser.username;
  
  if (overlay) overlay.style.display = 'none';
  if (app) app.style.display = 'flex';
  
  if (!socket) {
    connectWS();
    loadDashboard();
  }
}

function authLogout() {
  // Logout disabled as per user request to jump directly into website
  console.log('Logout attempt blocked (bypass active)');
}

let authMode           = 'login'; // 'login' or 'register'

// ── AUTH MODE SWITCH ─────────────────────────────────────────────────────────
function toggleAuthMode() {
  authMode = (authMode === 'login' ? 'register' : 'login');
  const submitBtn = document.getElementById('auth-submit');
  const modeText = document.getElementById('mode-text');
  const modeLink = document.getElementById('mode-link');
  const labelUser = document.getElementById('label-username');

  if (authMode === 'register') {
    submitBtn.textContent = 'Create Account';
    modeText.textContent = 'Already have an account?';
    modeLink.textContent = 'Sign In';
    if (labelUser) labelUser.textContent = 'Register Username';
  } else {
    submitBtn.textContent = 'Sign In';
    modeText.textContent = "Don't have an account?";
    modeLink.textContent = 'Create Account';
    if (labelUser) labelUser.textContent = 'Username';
  }
}

// ── GOOGLE LOGIN ─────────────────────────────────────────────────────────────
async function handleGoogleLogin() {
  showToast('Standard Login Required', 'Please use username/password for library monitor.', 'info');
}

// ── SIGN IN / REGISTER HANDLER ───────────────────────────────────────────────
document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('auth-username').value;
  const pass = document.getElementById('auth-password').value;
  const btn = document.getElementById('auth-submit');

  btn.disabled = true;
  btn.textContent = authMode === 'login' ? 'Verifying...' : 'Creating...';

  try {
    if (authMode === 'login') {
      const res = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password: pass })
      });
      authToken = res.access_token;
      localStorage.setItem('lms_token', authToken);
      showToast('Welcome', `Successfully signed in as ${username}`, 'success');
      await checkAuth();
    } else {
      await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password: pass })
      });
      showToast('Account Created', 'Your account has been registered. You can now sign in.', 'success');
      authMode = 'register';
      toggleAuthMode(); // Switch back to login
    }
  } catch (err) {
    showToast(authMode === 'login' ? 'Login Failed' : 'Registration Failed', err.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? 'Sign In' : 'Create Account';
  }
});
// ── AUDIT LOGS ────────────────────────────────────────────────────────────────
async function loadAuditLogs() {
  const tbody = document.getElementById('audit-body');
  tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">Loading…</td></tr>';
  try {
    const data = await apiFetch('/auth/audit_logs');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No logs available</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(i => `
      <tr>
        <td style="font-family:var(--font-mono);font-size:11px">${fmtDate(i.timestamp)}</td>
        <td><strong>${escHtml(i.username)}</strong></td>
        <td><span class="pill pill-neutral" style="font-family:var(--font-mono)">${escHtml(i.action)}</span></td>
        <td>${escHtml(i.details || '—')}</td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-cell" style="color:var(--danger)">Error: ${e.message}</td></tr>`;
  }
}

function escHtml(v) {
  if (v === null || v === undefined) return '—';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

async function loadKohaActionLogs() {
  const body = document.getElementById('koha-audit-body');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6" class="empty-cell">Loading Koha logs…</td></tr>';
  try {
    const data = await apiFetch('/auth/koha-action-logs');
    if (!data || data.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="empty-cell">No Koha logs found</td></tr>';
      return;
    }
    body.innerHTML = data.map(log => `
      <tr>
        <td style="white-space:nowrap">${new Date(log.timestamp).toLocaleString()}</td>
        <td><strong>${escHtml(log.user_name)}</strong></td>
        <td><span class="badge" style="background:var(--bg-hover); color:var(--info); border:1px solid var(--info-bg)">${escHtml(log.module)}</span></td>
        <td><code>${escHtml(log.action)}</code></td>
        <td>${escHtml(log.object)}</td>
        <td style="font-size:11px; color:var(--text-muted); max-width:300px; overflow:hidden; text-overflow:ellipsis;">${escHtml(log.info)}</td>
      </tr>
    `).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="empty-cell" style="color:var(--danger)">Error: ${e.message}</td></tr>`;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 10. IOT DEVICES
// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// 10. IOT DEVICES (BLENDER NODE EDITOR)
// ══════════════════════════════════════════════════════════════════════════════

class NodeEditor {
  constructor(workspaceId, containerId, svgId) {
    this.workspace = document.getElementById(workspaceId);
    this.container = document.getElementById(containerId);
    this.svg = document.getElementById(svgId);
    this.nodes = new Map(); // id -> nodeData
    this.connections = [];
    this.isDragging = false;
    this.dragNode = null;
    this.dragOffset = { x: 0, y: 0 };
    
    if (this.workspace) {
      this.initEvents();
    }
  }

  initEvents() {
    if (!this.workspace) return;
    this.workspace.addEventListener('mousedown', (e) => {
      const nodeEl = e.target.closest('.node');
      if (nodeEl && e.target.closest('.node-header')) {
        this.isDragging = true;
        this.dragNode = nodeEl;
        const rect = nodeEl.getBoundingClientRect();
        this.dragOffset.x = e.clientX - rect.left;
        this.dragOffset.y = e.clientY - rect.top;
        
        // Bring to front
        if (this.container) this.container.appendChild(nodeEl);
        
        // Select
        this.selectNode(nodeEl);
      } else if (!e.target.closest('.node')) {
        this.deselectAll();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging && this.dragNode && this.workspace) {
        const workspaceRect = this.workspace.getBoundingClientRect();
        let x = e.clientX - workspaceRect.left - this.dragOffset.x;
        let y = e.clientY - workspaceRect.top - this.dragOffset.y;
        
        // Constrain
        x = Math.max(0, Math.min(x, workspaceRect.width - this.dragNode.offsetWidth));
        y = Math.max(0, Math.min(y, workspaceRect.height - this.dragNode.offsetHeight));
        
        this.dragNode.style.left = x + 'px';
        this.dragNode.style.top = y + 'px';
        
        this.updateConnections();
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.dragNode = null;
    });
  }

  selectNode(nodeEl) {
    document.querySelectorAll('.node').forEach(n => n.classList.remove('selected'));
    nodeEl.classList.add('selected');
    
    const deviceId = nodeEl.id.replace('node-', '');
    if (deviceId !== 'master') {
      const device = Array.from(this.nodes.values()).find(n => n.device && (n.device.id == deviceId || n.device.device_id == deviceId))?.device;
      if (device) updateDeviceSidebar(device);
    } else {
      this.deselectAll();
    }
  }

  deselectAll() {
    document.querySelectorAll('.node').forEach(n => n.classList.remove('selected'));
    setDisplay('sidebar-content', 'none');
    setDisplay('sidebar-empty', 'flex');
  }

  createNode(device, type = 'slave') {
    const isMaster = type === 'master';
    const id = isMaster ? 'master' : device.id;
    const isOnline = isMaster || (device && device.status === 'ONLINE');
    
    let nodeEl = document.getElementById(`node-${id}`);
    const isNew = !nodeEl;
    
    if (isNew) {
      nodeEl = document.createElement('div');
      nodeEl.id = `node-${id}`;
      nodeEl.className = `node ${type}`;
      
      // Auto-layout: Orbit around center
      if (isMaster) {
        nodeEl.style.left = 'calc(50% - 120px)';
        nodeEl.style.top = '100px';
      } else {
        const index = Array.from(this.nodes.keys()).length; 
        const angle = (index * 60) * (Math.PI / 180);
        const radius = 220;
        const centerX = (this.workspace.clientWidth / 2) || 400;
        const centerY = 150;
        nodeEl.style.left = (centerX + radius * Math.cos(angle) - 100) + 'px';
        nodeEl.style.top = (centerY + radius * Math.sin(angle)) + 'px';
      }

      const deleteBtn = isMaster ? '' : `<button class="node-delete-btn" title="Unregister" onclick="event.stopPropagation(); deleteDevice('${device.device_id}')">×</button>`;
      
      nodeEl.innerHTML = `
        <div class="node-header node-type-${type} ${!isOnline ? 'offline' : ''}">
          <span>${isMaster ? 'Security Gateway' : device.name}</span>
          ${deleteBtn}
        </div>
        <div class="node-content">
          <div class="node-item">
            <span class="label">${isMaster ? 'Core IP' : 'Status'}</span>
            <span class="value status-val" style="color:${isOnline ? 'var(--success)' : 'var(--danger)'}">${isMaster ? '137.184.15.52' : device.status}</span>
          </div>
          ${isMaster ? '' : `
            <div class="node-item">
              <span class="label">CPU</span>
              <span class="value cpu-val">${(device.cpu_usage || 0).toFixed(1)}%</span>
            </div>
            <div class="node-item">
              <span class="label">RAM</span>
              <span class="value ram-val">${(device.ram_usage || 0).toFixed(1)}%</span>
            </div>
          `}
        </div>
      `;
      
      if (!isMaster) {
        nodeEl.addEventListener('dblclick', () => openDeviceModal(device));
      }
      
      if (this.container) this.container.appendChild(nodeEl);
      this.nodes.set(id, { element: nodeEl, type, device });
    } else if (!isMaster) {
      // Update existing slave
      this.nodes.get(id).device = device;
      const header = nodeEl.querySelector('.node-header');
      if (header) {
        header.className = `node-header node-type-${type} ${!isOnline ? 'offline' : ''}`;
      }
      
      // If currently selected in sidebar, update sidebar too
      const selected = document.querySelector('.node.selected');
      if (selected && selected.id === `node-${id}`) {
        updateDeviceSidebar(device);
      }

      const cpuVal = nodeEl.querySelector('.cpu-val');
      const ramVal = nodeEl.querySelector('.ram-val');
      const statusVal = nodeEl.querySelector('.status-val');
      
      if (cpuVal) cpuVal.textContent = (device.cpu_usage || 0).toFixed(1) + '%';
      if (ramVal) ramVal.textContent = (device.ram_usage || 0).toFixed(1) + '%';
      if (statusVal) {
        statusVal.textContent = device.status;
        statusVal.style.color = isOnline ? 'var(--success)' : 'var(--danger)';
      }
    }
    
    return id;
  }

  updateConnections() {
    if (!this.svg) return;
    this.svg.innerHTML = '';
    const masterNode = this.nodes.get('master');
    if (!masterNode) return;

    this.nodes.forEach((node, id) => {
      if (id === 'master') return;
      this.drawBezier(masterNode.element, node.element);
    });
  }

  drawBezier(startEl, endEl) {
    if (!this.svg || !this.workspace) return;
    const wr = this.workspace.getBoundingClientRect();
    const sr = startEl.getBoundingClientRect();
    const er = endEl.getBoundingClientRect();

    // Source (Master) anchor: middle-right
    const sx = (sr.left - wr.left) + startEl.offsetWidth;
    const sy = (sr.top - wr.top) + (startEl.offsetHeight / 2);

    // Target (Slave) anchor: middle-left
    const ex = (er.left - wr.left);
    const ey = (er.top - wr.top) + (endEl.offsetHeight / 2);

    const cp1 = sx + Math.abs(ex - sx) * 0.4;
    const cp2 = ex - Math.abs(ex - sx) * 0.4;
    
    const pathData = `M ${sx} ${sy} C ${cp1} ${sy}, ${cp2} ${ey}, ${ex} ${ey}`;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", pathData);
    line.setAttribute("class", "connection-wire data-flowing");
    this.svg.appendChild(line);
  }
}

let iotEditor = null;

async function loadDevices() {
  setHTML('devices-body', '<tr><td colspan="6" class="empty-cell">Syncing device fleet...</td></tr>');
  
  if (!iotEditor) {
    iotEditor = new NodeEditor('node-workspace', 'nodes-container', 'node-connections-svg');
  }
  
  try {
    const devices = await apiFetch('/devices/');
    
    // 1. Update Summaries
    const total = Array.isArray(devices) ? devices.length : 0;
    const online = Array.isArray(devices) ? devices.filter(d => d.status === 'ONLINE').length : 0;
    setText('iot-total-count', total);
    setText('iot-online-count', online);
    setText('iot-offline-count', total - online);

    // 2. Update Node Editor
    if ($('node-workspace')) {
      iotEditor.createNode(null, 'master');
      if (Array.isArray(devices)) {
        devices.forEach(d => iotEditor.createNode(d, 'slave'));
      }
      iotEditor.updateConnections();
    }

    // 3. Update Table
    if (!Array.isArray(devices) || !devices.length) {
      setHTML('devices-body', '<tr><td colspan="6" class="empty-cell">No IoT endpoints found in current subnet</td></tr>');
      return;
    }
    
    const html = devices.map(d => {
      const isOnline = d.status === 'ONLINE';
      return `
        <tr id="dev-${d.id}" style="cursor:pointer" onclick="openDeviceModal(${JSON.stringify(d).replace(/'/g, "&apos;")})">
          <td><strong>${escHtml(d.name || 'Unknown')}</strong></td>
          <td style="font-family:var(--font-mono);font-size:11px">${escHtml(d.device_id || 'N/A')}<br><span style="color:var(--text-muted)">${escHtml(d.ip_address || '')}</span></td>
          <td>${escHtml(d.floor_name || '')}</td>
          <td>${isOnline ? '<span class="pill pill-success">ONLINE</span>' : '<span class="pill pill-danger">OFFLINE</span>'}</td>
          <td>${isOnline ? 'Just now' : fmtDate(d.last_heartbeat)}</td>
          <td>
            <button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); deleteDevice('${d.device_id}')">Unregister</button>
          </td>
        </tr>
      `;
    }).join('');
    setHTML('devices-body', html);
  } catch (e) {
    console.error('loadDevices error:', e);
    setHTML('devices-body', `<tr><td colspan="6" class="empty-cell" style="color:var(--danger)">Fleet synchronization failed: ${e.message}</td></tr>`);
  }
}

function updateDeviceSidebar(d) {
  setDisplay('sidebar-empty', 'none');
  setDisplay('sidebar-content', 'flex');
  
  setText('sb-device-name', d.name);
  setText('sb-device-id', d.device_id);
  setText('sb-ip', d.ip_address || '0.0.0.0');
  setText('sb-location', d.floor_name || 'System Managed');
  
  const isOnline = d.status === 'ONLINE';
  const pill = $('sb-status-pill');
  if (pill) {
    pill.textContent = d.status;
    pill.className = isOnline ? 'pill pill-success' : 'pill pill-danger';
  }
  
  const cpu = (d.cpu_usage || 0).toFixed(1);
  const ram = (d.ram_usage || 0).toFixed(1);
  
  setText('sb-cpu-text', cpu + '%');
  setText('sb-ram-text', ram + '%');
  
  const cpuBar = $('sb-cpu-bar');
  const ramBar = $('sb-ram-bar');
  if (cpuBar) cpuBar.style.width = cpu + '%';
  if (ramBar) ramBar.style.width = ram + '%';
  
  $('sb-term-btn').onclick = () => openDeviceModal(d);
  $('sb-delete-btn').onclick = () => deleteDevice(d.device_id);
}

async function deleteDevice(deviceId) {
  if(!confirm('Unregister this IoT node?')) return;
  try {
    await apiFetch(`/devices/${deviceId}`, { method: 'DELETE' });
    showToast('Removed', 'Device unregistered', 'warning');
    // Remove from node editor
    const node = document.getElementById(`node-${deviceId}`);
    if (node) node.remove();
    loadDevices();
  } catch(e) {
    showToast('Error', e.message, 'danger');
  }
}

function toggleAddDeviceForm() {
  const form = document.getElementById('add-device-form-container');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function addDevice(evt) {
  evt.preventDefault();
  
  const macEl = $('dev-mac');
  const ipEl  = $('dev-ip');
  const nameEl = $('dev-name');
  const floorEl = $('dev-floor');
  const xEl = $('dev-x');
  const yEl = $('dev-y');

  const body = {
    device_id:  macEl ? macEl.value.trim() : '',
    ip_address: ipEl ? ipEl.value.trim() : null,
    name:       nameEl ? nameEl.value.trim() : 'Unnamed Node',
    floor_name: floorEl ? floorEl.value.trim() : 'Ground Floor',
    x_pos:      xEl ? parseFloat(xEl.value) : 10 + Math.random() * 80,
    y_pos:      yEl ? parseFloat(yEl.value) : 10 + Math.random() * 80,
  };
  
  if (!body.device_id) {
    showToast('Validation Error', 'MAC Address is required', 'warning');
    return;
  }
  
  try {
    await apiFetch('/devices/', { method: 'POST', body: JSON.stringify(body) });
    showToast('Success', 'Node registered successfully', 'success');
    const form = $('add-device-form');
    if (form) form.reset();
    toggleAddDeviceForm();
    loadDevices();
  } catch(e) {
    showToast('Error', e.message, 'danger');
  }
}

async function scanNetwork() {
  const container = document.getElementById('scan-results');
  if (container) container.innerHTML = '<span class="blink">Scanning subnet... please wait (takes ~5s)</span>';
  try {
    const res = await apiFetch('/devices/scan');
    if (!res.scanned_devices || res.scanned_devices.length === 0) {
      if (container) container.innerHTML = '<span style="color:var(--text-muted)">No devices found on local network ARP cache.</span>';
      return;
    }
    
    if (container) {
      container.innerHTML = '<div style="margin-bottom: 5px;"><strong>Discovered Devices:</strong></div>' + 
      res.scanned_devices.map(d => {
        const isPi = d.is_pi ? '<span class="pill pill-success" style="font-size:10px;">Raspberry Pi</span>' : '';
        return `
          <div style="display:flex; justify-content:space-between; align-items:center; padding: 6px; border-bottom: 1px solid var(--border);">
            <div><strong style="font-family:var(--font-mono)">${d.mac}</strong> (${d.ip}) ${isPi}</div>
            <button type="button" class="btn btn-outline btn-sm" onclick="selectScannedDevice('${d.mac}', '${d.ip}')">Select</button>
          </div>
        `;
      }).join('');
    }
      
  } catch (e) {
    if (container) container.innerHTML = `<span style="color:var(--danger)">Scan failed: ${e.message}</span>`;
  }
}

function selectScannedDevice(mac, ip) {
  document.getElementById('dev-mac').value = mac;
  document.getElementById('dev-ip').value = ip;
  if(!document.getElementById('dev-name').value) {
    document.getElementById('dev-name').value = 'Pi Node ' + ip.split('.').pop();
  }
  document.getElementById('dev-name').focus();
}

function openDeviceModal(d) {
  currentDeviceId = d.device_id;
  currentDeviceIp = d.ip_address || "Unknown IP";
  
  document.getElementById('device-modal').style.display = 'flex';
  document.getElementById('modal-device-name').textContent = 'Terminal — ' + d.name;
  
  document.getElementById('mod-cpu').textContent = d.cpu_usage ? d.cpu_usage.toFixed(1) + '%' : '0%';
  document.getElementById('mod-ram').textContent = d.ram_usage ? d.ram_usage.toFixed(1) + '%' : '0%';
  
  const statEl = document.getElementById('mod-status');
  statEl.textContent = d.status;
  statEl.style.color = d.status === 'ONLINE' ? 'var(--success)' : 'var(--danger)';
  
  const hostname = d.name.replace(/\s+/g,'').toLowerCase();
  document.getElementById('term-hostname').textContent = hostname;
  document.getElementById('ssh-target-ip').textContent = currentDeviceIp;
  
  // Show SSH Login overlay
  document.getElementById('ssh-login-overlay').style.display = 'flex';
  document.getElementById('ssh-pwd').value = '';
  document.getElementById('term-input').disabled = true;
  
  if (!xterm) {
    xterm = new Terminal({
      theme: { background: '#000000', foreground: '#00ff00' },
      fontFamily: 'var(--font-mono)', fontSize: 12
    });
    fitAddon = new FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
    const tEl = document.getElementById('ssh-terminal');
    if (tEl) tEl.innerHTML = '';
    if (xterm) xterm.open(tEl);
  }
  setTimeout(() => fitAddon.fit(), 100);
  xterm.clear();
  xterm.write(`Starting Secure Shell Session...\\r\\n`);
}

function closeDeviceModal() {
  document.getElementById('device-modal').style.display = 'none';
  if (currentDeviceId && socket && socket.readyState === 1) {
    socket.send(JSON.stringify({
      action: 'ssh_disconnect',
      device_id: currentDeviceId
    }));
  }
}

function connectRealSSH() {
  const user = document.getElementById('ssh-user').value;
  const pwd = document.getElementById('ssh-pwd').value;
  
  if (!currentDeviceId || !socket || socket.readyState !== 1) return;
  
  xterm.write("Authenticating...\\r\\n");
  
  socket.send(JSON.stringify({
    action: 'ssh_connect',
    device_id: currentDeviceId,
    ip: currentDeviceIp,
    username: user,
    password: pwd
  }));
}

function sendTerminalCommand(cmd) {
  if (!currentDeviceId || !socket || socket.readyState !== 1 || !cmd.trim()) return;
  
  socket.send(JSON.stringify({
    action: 'ssh_input',
    device_id: currentDeviceId,
    command: cmd.trim() + '\n'
  }));
}

function handleTerminalKey(evt) {
  if (evt.key === 'Enter') {
    const el = document.getElementById('term-input');
    sendTerminalCommand(el.value);
    el.value = '';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 11.  INIT
// ══════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
});
