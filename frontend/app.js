/**
 * app.js — JPL Security Monitor Frontend
 * Handles: WebSocket, SPA navigation, REST API calls,
 *          live event stream, whitelist CRUD, alerts.
 */

const API_BASE = window.location.origin + '/api/v1';
const WS_URL   = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';

// ── State ─────────────────────────────────────────────────────────────────────
let socket             = null;
let reconnectTimer     = null;
let sessionEventCount  = 0;
let unackedAlertCount  = 0;
let currentTable       = null;
let currentPage        = 1;
let searchDebounce     = null;
let allTableNames      = [];

// ══════════════════════════════════════════════════════════════════════════════
// 1.  NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');

  // Lazy-load on first visit
  if (name === 'tables' && allTableNames.length === 0) loadTableList();
  if (name === 'whitelist') loadWhitelist();
  if (name === 'alerts') loadAlerts();
  if (name === 'devices') loadDevices();
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
    case 'whitelist_update':
      handleWhitelistUpdate(msg.data);
      break;
    case 'device_update':
      if (document.getElementById('view-devices').classList.contains('active')) {
        loadDevices();
      }
      break;
    case 'pong':
      break; // keep-alive reply
  }
}

function handleLiveRow(data) {
  sessionEventCount++;
  document.getElementById('kpi-events-val').textContent = sessionEventCount;
  addStreamRow(data.event, data.table, data.row, false);

  // If the live table viewer is showing this table, highlight new row
  if (currentTable === data.table) {
    refreshTable();
  }
}

function handleSecurityAlert(data) {
  unackedAlertCount++;
  updateAlertBadge();

  // Angry toast
  showToast(
    '🚨 Security Alert',
    data.message || `Non-whitelisted barcode: ${data.barcode}`,
    'danger',
    8000
  );

  addStreamRow('ALERT', 'issues', { barcode: data.barcode, branch: data.branch_code }, true);
  refreshDashboardAlerts();

  // Update KPI
  document.getElementById('kpi-unacked-val').textContent = unackedAlertCount;
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
function addStreamRow(event, table, row, isAlert) {
  const container = document.getElementById('event-stream');
  const empty = container.querySelector('.stream-empty');
  if (empty) empty.remove();

  const ts = new Date().toLocaleTimeString();
  const badgeClass = isAlert ? 'badge-alert' : { INSERT: 'badge-insert', UPDATE: 'badge-update', DELETE: 'badge-delete' }[event] || 'badge-insert';
  const detail = isAlert
    ? `<strong>⚠ UNAUTHORIZED CHECKOUT</strong> — barcode: <code>${row.barcode}</code> branch: ${row.branch || '?'}`
    : `Table: <strong>${table}</strong> &nbsp;${summariseRow(row)}`;

  const div = document.createElement('div');
  div.className = 'stream-row' + (isAlert ? ' alert-row' : '');
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
    unackedAlertCount = alertsRes.length;
    updateAlertBadge();
    document.getElementById('kpi-unacked-val').textContent = unackedAlertCount;
    document.getElementById('kpi-whitelist-val').textContent = wlRes.length;
    renderDashboardAlerts(alertsRes);
  } catch (e) {
    console.warn('Dashboard load error:', e);
  }
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
  if (!alerts.length) {
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
  const list = document.getElementById('table-list');
  list.innerHTML = '<div class="loading-placeholder">Loading…</div>';
  try {
    allTableNames = await apiFetch('/tables/');
    renderTableList(allTableNames);
  } catch (e) {
    list.innerHTML = '<div class="loading-placeholder" style="color:var(--danger)">Failed to load tables</div>';
  }
}

function renderTableList(tables) {
  const list = document.getElementById('table-list');
  list.innerHTML = tables.map(t => `
    <div class="table-list-item ${t === currentTable ? 'active' : ''}"
         id="tl-${t}"
         onclick="selectTable('${t}')">${t}</div>
  `).join('') || '<div class="loading-placeholder">No tables found</div>';
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
  const wrap = document.getElementById('table-data-wrap');
  wrap.innerHTML = '<div class="loading-placeholder">Loading rows…</div>';
  try {
    const params = new URLSearchParams({
      page: currentPage,
      page_size: 50,
      ...(search ? { search } : {}),
    });
    const data = await apiFetch(`/tables/${currentTable}?${params}`);
    renderTableData(data);
  } catch (e) {
    wrap.innerHTML = `<div class="loading-placeholder" style="color:var(--danger)">Error: ${e.message}</div>`;
  }
}

function renderTableData(data) {
  document.getElementById('table-meta').textContent =
    `${data.total.toLocaleString()} rows total • Page ${data.page} • ${data.columns.length} columns`;

  if (!data.rows.length) {
    document.getElementById('table-data-wrap').innerHTML = '<div class="loading-placeholder">No rows found</div>';
    document.getElementById('table-pagination').innerHTML = '';
    return;
  }

  const thead = `<thead><tr>${data.columns.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${data.rows.map(row =>
    `<tr>${data.columns.map(c => `<td title="${escHtml(row[c])}">${escHtml(row[c])}</td>`).join('')}</tr>`
  ).join('')}</tbody>`;

  document.getElementById('table-data-wrap').innerHTML = `<table class="data-table">${thead}${tbody}</table>`;
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
// 9.  UTILITIES
// ══════════════════════════════════════════════════════════════════════════════
async function apiFetch(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
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

// ══════════════════════════════════════════════════════════════════════════════
// 10. IOT DEVICES
// ══════════════════════════════════════════════════════════════════════════════
async function loadDevices() {
  const tbody = document.getElementById('devices-body');
  const mapContainer = document.getElementById('device-nodes-container');
  tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Loading Devices…</td></tr>';
  
  try {
    const devices = await apiFetch('/devices/');
    mapContainer.innerHTML = ''; // clear floor map nodes
    
    if (!devices.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No Gate/Security Controllers Connected</td></tr>';
      return;
    }
    
    tbody.innerHTML = devices.map(d => {
      const isOnline = d.status === 'ONLINE';
      // Add node to map
      const node = document.createElement('div');
      node.style.position = 'absolute';
      node.style.left = d.x_pos + '%';
      node.style.top = d.y_pos + '%';
      node.style.width = '14px';
      node.style.height = '14px';
      node.style.borderRadius = '50%';
      node.style.background = isOnline ? 'var(--success)' : 'var(--danger)';
      node.style.boxShadow = '0 0 10px ' + (isOnline ? 'var(--success)' : 'var(--danger)');
      node.style.transform = 'translate(-50%, -50%)';
      node.title = d.name + ' (' + d.status + ')';
      
      // Node Pulse Animation
      const pulse = document.createElement('div');
      pulse.style.position = 'absolute';
      pulse.style.top = '0'; pulse.style.left = '0';
      pulse.style.width = '100%'; pulse.style.height = '100%';
      pulse.style.borderRadius = '50%';
      pulse.style.background = 'inherit';
      pulse.style.animation = isOnline ? 'pulse-kpi 2s infinite' : 'none';
      node.appendChild(pulse);
      
      // Node label
      const label = document.createElement('div');
      label.textContent = d.name;
      label.style.position = 'absolute';
      label.style.top = '20px';
      label.style.left = '50%';
      label.style.transform = 'translateX(-50%)';
      label.style.fontSize = '10px';
      label.style.fontWeight = 'bold';
      label.style.color = '#333';
      label.style.whiteSpace = 'nowrap';
      node.appendChild(label);
      
      mapContainer.appendChild(node);
      
      return `
        <tr id="dev-${d.id}" style="cursor:pointer" onclick='openDeviceModal(${JSON.stringify(d).replace(/'/g, "&apos;")})'>
          <td><strong>${escHtml(d.name)}</strong></td>
          <td style="font-family:var(--font-mono);font-size:11px">${escHtml(d.device_id)}<br><span style="color:var(--text-muted)">${escHtml(d.ip_address || '')}</span></td>
          <td>${escHtml(d.floor_name)}</td>
          <td>${isOnline ? '<span class="pill pill-success">ONLINE</span>' : '<span class="pill pill-danger">OFFLINE</span>'}</td>
          <td>${isOnline ? 'Just now' : fmtDate(d.last_heartbeat)}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell" style="color:var(--danger)">Error: ${e.message}</td></tr>`;
  }
}

function toggleAddDeviceForm() {
  const form = document.getElementById('add-device-form-container');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function addDevice(evt) {
  evt.preventDefault();
  const body = {
    device_id: document.getElementById('dev-mac').value.trim(),
    ip_address: document.getElementById('dev-ip').value.trim() || null,
    name: document.getElementById('dev-name').value.trim(),
    floor_name: document.getElementById('dev-floor').value.trim(),
    x_pos: parseFloat(document.getElementById('dev-x').value) || 50,
    y_pos: parseFloat(document.getElementById('dev-y').value) || 50,
  };
  
  try {
    await apiFetch('/devices/', { method: 'POST', body: JSON.stringify(body) });
    showToast('Success', 'Slave Device registered / updated', 'success');
    document.getElementById('add-device-form').reset();
    toggleAddDeviceForm();
    loadDevices();
  } catch(e) {
    showToast('Error', e.message, 'danger');
  }
}

async function scanNetwork() {
  const container = document.getElementById('scan-results');
  container.innerHTML = '<span class="blink">Scanning subnet... please wait (takes ~5s)</span>';
  try {
    const res = await apiFetch('/devices/scan');
    if (!res.scanned_devices || res.scanned_devices.length === 0) {
      container.innerHTML = '<span style="color:var(--text-muted)">No devices found on local network ARP cache.</span>';
      return;
    }
    
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
      
  } catch (e) {
    container.innerHTML = `<span style="color:var(--danger)">Scan failed: ${e.message}</span>`;
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
  document.getElementById('device-modal').style.display = 'flex';
  document.getElementById('modal-device-name').textContent = 'Terminal — ' + d.name;
  
  document.getElementById('mod-cpu').textContent = d.cpu_usage ? d.cpu_usage.toFixed(1) + '%' : '0%';
  document.getElementById('mod-ram').textContent = d.ram_usage ? d.ram_usage.toFixed(1) + '%' : '0%';
  
  const statEl = document.getElementById('mod-status');
  statEl.textContent = d.status;
  statEl.style.color = d.status === 'ONLINE' ? 'var(--success)' : 'var(--danger)';
  
  const term = document.getElementById('ssh-terminal');
  term.innerHTML = `Last login: ${new Date().toLocaleString()} from Master Node<br>pi@${d.name.replace(/\s+/g,'').toLowerCase()}:~ $ <span class="blink">_</span>`;
}

function mockTerminalPrint(cmd) {
  const term = document.getElementById('ssh-terminal');
  term.innerHTML = term.innerHTML.replace('<span class="blink">_</span>', cmd + '<br>Executing... [OK]<br>pi@node:~ $ <span class="blink">_</span>');
  term.scrollTop = term.scrollHeight;
}

// ══════════════════════════════════════════════════════════════════════════════
// 11.  INIT
// ══════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  connectWS();
  loadDashboard();
});
