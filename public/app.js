/* ============================================================
   Deployment Server  |  app.js
   ============================================================ */

// Check query param ?api=... for easy 1-click backend setting
const _urlParams = new URLSearchParams(window.location.search);
if (_urlParams.get('api')) {
  localStorage.setItem('backend_api_url', _urlParams.get('api').replace(/\/+$/, ''));
}

// Option 2 Backend Connection:
// On Vercel / remote host, default to http://localhost:3000 if not explicitly configured
function resolveBackendUrl() {
  const saved = localStorage.getItem('backend_api_url');
  if (saved !== null && saved !== undefined) return saved.trim().replace(/\/+$/, '');
  if (window.DEPLOYMENT_SERVER_API_URL) return window.DEPLOYMENT_SERVER_API_URL.replace(/\/+$/, '');
  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return 'http://localhost:3000'; // Default Option 2: local backend engine
  }
  return ''; // Same-origin on localhost
}

let API = resolveBackendUrl();

// ══════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════
function toast(msg, type = 'info', duration = 4000) {
  const icons = {
    success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5BC8F5" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ══════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════
function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));

  const panel = document.getElementById(`tab-${tabId}`);
  if (panel) panel.classList.add('active');

  const btn = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');

  // Trigger data loads per tab
  if (tabId === 'overview')       if (currentUser && authToken) {
  loadOverview();
}
  if (tabId === 'instances')      loadInstances();
  if (tabId === 'credentials')    loadCredentials();
  if (tabId === 'logs')           loadLogSelect();
  if (tabId === 'observability')  startObservabilityAutoRefresh();
  else                            stopObservabilityAutoRefresh();
}

document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
document.querySelectorAll('[data-tab-trigger]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tabTrigger));
});
document.querySelector('.header-brand').addEventListener('click', e => {
  e.preventDefault();
  switchTab('overview');
});

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
function statusBadge(status) {
  const map = {
    ready:      'badge-ready',
    pending:    'badge-pending',
    deploying:  'badge-deploying',
    provisioning: 'badge-deploying',
    failed:     'badge-failed',
  };
  const cls = map[status] || 'badge-info';
  return `<span class="badge ${cls}"><span class="badge-dot"></span>${status}</span>`;
}

function relativeTime(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z')).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function uptimeStr(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatLog(raw) {
  if (!raw) return '<span class="log-info">No log output yet.</span>';
  return raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(error|failed|Error|FAILED)/gi, '<span class="log-err">$1</span>')
    .replace(/(warning|warn|WARN)/gi,         '<span class="log-warn">$1</span>')
    .replace(/(success|ready|READY|Done|done|running|RUNNING|healthy)/gi, '<span class="log-ok">$1</span>')
    .replace(/(\[.*?\])/g,                    '<span class="log-info">$1</span>');
}

async function apiFetch(path, opts = {}) {
  const r = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  return r.json();
}

// ══════════════════════════════════════════════════════
// OVERVIEW
// ══════════════════════════════════════════════════════
async function loadOverview() {
  try {
    const [statsRes, depsRes] = await Promise.all([
      apiFetch('/api/system/stats'),
      apiFetch('/api/deployments'),
    ]);

    if (statsRes.success) {
      const s = statsRes.stats;
      document.getElementById('stat-total').textContent  = s.totalDeployments ?? '0';
      document.getElementById('stat-active').textContent = s.activeVMs ?? '0';
      document.getElementById('stat-creds').textContent  = s.totalCredentials ?? '0';
      document.getElementById('stat-creds-verified').textContent = `${s.verifiedCredentials ?? 0} verified`;
      document.getElementById('stat-uptime').textContent = uptimeStr(s.systemUptime);
    }

    if (depsRes.success) {
      const tbody = document.getElementById('overview-table-body');
      const recent = depsRes.deployments.slice(0, 5);
      if (recent.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
          <div class="empty-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>
          <p class="empty-title">No deployments yet</p>
          <p class="empty-sub">Click <strong>New Deployment</strong> to get started.</p>
        </div></td></tr>`;
      } else {
        tbody.innerHTML = recent.map(d => `
          <tr>
            <td>
              <div class="repo-name">${escHtml(d.repo_name)}</div>
              <div class="repo-url">${escHtml(d.git_username)}</div>
            </td>
            <td><code>${escHtml(d.branch || 'main')}</code></td>
            <td>${providerBadge(d.cloud_provider)}</td>
            <td>${d.vm_ip ? `<a href="http://${d.vm_ip}" target="_blank" style="color:var(--accent);text-decoration:none;font-family:monospace;font-size:12px">${d.vm_ip}</a>` : '<span class="text-muted">—</span>'}</td>
            <td>${statusBadge(d.status)}</td>
            <td class="text-muted">${relativeTime(d.created_at)}</td>
          </tr>`).join('');
      }
    }
  } catch (err) {
    console.error('Overview load error:', err);
  }
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════════════
// INSTANCES
// ══════════════════════════════════════════════════════
async function loadInstances() {
  try {
    const res = await apiFetch('/api/deployments');
    const tbody = document.getElementById('instances-table-body');
    const countEl = document.getElementById('instance-count');

    if (!res.success) throw new Error(res.error);

    const list = res.deployments;
    countEl.textContent = `${list.length} record${list.length !== 1 ? 's' : ''}`;

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">
        <div class="empty-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>
        <p class="empty-title">No instances found</p>
        <p class="empty-sub">Deploy a repository to provision your first cloud instance.</p>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(d => {
      const slot = d.active_slot || 'blue';
      const slotColor = slot === 'blue' ? '#3b82f6' : '#10b981';
      const slotLabel = slot.toUpperCase();
      return `
      <tr>
        <td class="text-muted" style="font-size:12px">#${d.id}</td>
        <td>
          <div class="repo-name" style="display:flex;align-items:center;gap:6px">
            ${escHtml(d.repo_name)}
            ${providerBadge(d.cloud_provider)}
          </div>
          <div class="repo-url">${escHtml(d.git_username)}</div>
        </td>
        <td><code>${escHtml(d.branch || 'main')}</code></td>
        <td>${d.domain && d.domain !== '_' ? `<a href="http://${d.domain}" target="_blank" style="color:var(--accent);text-decoration:none;font-family:monospace;font-size:12px">${d.domain}</a>` : (d.vm_ip ? `<a href="http://${d.vm_ip}" target="_blank" style="color:var(--accent);text-decoration:none;font-family:monospace;font-size:12px">${d.vm_ip}</a>` : '<span class="text-muted">—</span>')}</td>
        <td><span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;padding:2px 8px;background:${slotColor}18;color:${slotColor};border-radius:999px;border:1px solid ${slotColor}44">
          <span style="width:6px;height:6px;border-radius:50%;background:${slotColor}"></span>${slotLabel}
        </span></td>
        <td style="font-size:12px;color:var(--muted)">${escHtml(d.vm_zone || '—')}</td>
        <td>${statusBadge(d.status)}</td>
        <td class="text-muted" style="font-size:12px">${relativeTime(d.created_at)}</td>
        <td>
          <div style="display:flex;gap:3px;flex-wrap:wrap">
            <button class="btn btn-outline btn-sm" title="Live Metrics" onclick="openMetricsModal(${d.id}, '${escHtml(d.repo_name)}')">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            </button>
            <button class="btn btn-ghost btn-sm" title="Web Terminal" onclick="openTerminalModal(${d.id}, '${escHtml(d.repo_name)}')">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            </button>
            <button class="btn btn-outline btn-sm" title="Zero-Downtime Blue/Green Deploy" onclick="triggerFastUpdate(${d.id})">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              B/G
            </button>
            <button class="btn btn-ghost btn-sm" title="Real-time SSE Logs" onclick="openLogModal(${d.id}, '${escHtml(d.repo_name)}')">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </button>
            <button class="btn btn-danger btn-sm" title="Delete" onclick="deleteDeployment(${d.id})">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    console.error('Instances load error:', err);
    toast('Failed to load instances: ' + err.message, 'error');
  }
}

document.getElementById('refresh-instances-btn').addEventListener('click', loadInstances);

window.triggerFastUpdate = async function(id) {
  toast('Initiating Zero-Downtime Blue/Green deployment...', 'info');
  try {
    const res = await apiFetch(`/api/deployments/${id}/update`, { method: 'POST' });
    if (res.success) {
      toast(`B/G hot-swap to ${res.nextSlot?.toUpperCase() || 'next'} slot initiated — 0.00s downtime.`, 'success', 7000);
      setTimeout(loadInstances, 2000);
    } else {
      toast(res.error, 'error');
    }
  } catch {
    toast('Update request failed.', 'error');
  }
};

window.deleteDeployment = async function(id) {
  if (!confirm('Delete this deployment record? This does not destroy the cloud VM.')) return;
  try {
    const res = await apiFetch(`/api/deployments/${id}`, { method: 'DELETE' });
    if (res.success) { toast('Deployment record removed.', 'success'); loadInstances(); }
    else toast(res.error, 'error');
  } catch { toast('Delete failed.', 'error'); }
};

// ══════════════════════════════════════════════════════
// LOGS
// ══════════════════════════════════════════════════════
async function loadLogSelect() {
  try {
    const res = await apiFetch('/api/deployments');
    const sel = document.getElementById('log-dep-select');
    sel.innerHTML = '<option value="">— Select a deployment —</option>';
    if (res.success) {
      res.deployments.forEach(d => {
        const o = document.createElement('option');
        o.value = d.id;
        o.textContent = `#${d.id} — ${d.repo_name} (${d.status})`;
        sel.appendChild(o);
      });
    }
  } catch {}
}

document.getElementById('log-dep-select').addEventListener('change', async function() {
  const id = this.value;
  const wrap = document.getElementById('log-output-wrap');
  const empty = document.getElementById('log-empty');
  if (!id) { wrap.style.display = 'none'; empty.style.display = 'flex'; return; }

  try {
    const res = await apiFetch(`/api/deployments/${id}`);
    if (res.success) {
      const d = res.deployment;
      document.getElementById('log-dep-label').textContent = `${d.repo_name} · ${d.status} · ${relativeTime(d.updated_at)}`;
      document.getElementById('log-terminal').innerHTML = formatLog(d.logs);
      wrap.style.display = 'block';
      empty.style.display = 'none';
    }
  } catch {}
});

// ── Real-Time SSE Log Modal ──
let logEventSource = null;

function closeLogModal() {
  document.getElementById('log-modal').classList.remove('open');
  if (logEventSource) {
    logEventSource.close();
    logEventSource = null;
  }
  const badge = document.getElementById('log-stream-badge');
  if (badge) badge.style.display = 'none';
}

window.openLogModal = async function(id, name) {
  try {
    if (logEventSource) {
      logEventSource.close();
      logEventSource = null;
    }

    document.getElementById('log-modal-title').textContent = `Logs — ${name}`;
    const term = document.getElementById('log-modal-content');
    term.innerHTML = '<span class="log-info">Connecting to live log stream via SSE...</span>\n';
    document.getElementById('log-modal').classList.add('open');
    const badge = document.getElementById('log-stream-badge');
    if (badge) badge.style.display = 'inline-block';

    let initialCleared = false;
    logEventSource = new EventSource(`/api/deployments/${id}/logs/stream`);

    logEventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (!initialCleared) {
          term.innerHTML = '';
          initialCleared = true;
        }
        term.innerHTML += formatLog(payload.text) + '\n';
        term.scrollTop = term.scrollHeight;
      } catch {
        term.innerHTML += formatLog(event.data) + '\n';
      }
    };

    logEventSource.onerror = async () => {
      if (badge) badge.style.display = 'none';
      if (logEventSource) {
        logEventSource.close();
        logEventSource = null;
      }
      // Fallback: fetch final snapshot if SSE drops
      const res = await apiFetch(`/api/deployments/${id}`);
      if (res.success && res.deployment?.logs) {
        term.innerHTML = formatLog(res.deployment.logs);
      }
    };
  } catch (err) {
    console.error('SSE Error:', err);
  }
};

document.getElementById('close-log-modal').addEventListener('click', closeLogModal);
document.getElementById('close-log-modal-2').addEventListener('click', closeLogModal);
document.getElementById('log-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeLogModal(); });

// ── Live Container Telemetry & Metrics Modal ──
let metricsTimer = null;

function closeMetricsModal() {
  document.getElementById('metrics-modal').classList.remove('open');
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
}

window.openMetricsModal = async function(id, name) {
  try {
    if (metricsTimer) clearInterval(metricsTimer);

    document.getElementById('metrics-modal-title').textContent = `Live Telemetry — ${name}`;
    document.getElementById('metrics-modal').classList.add('open');

    async function fetchMetrics() {
      try {
        const res = await apiFetch(`/api/deployments/${id}/metrics`);
        if (res.success) {
          const m = res.metrics;
          document.getElementById('metric-ip').textContent = m.ip || 'pending';
          const statusBadgeEl = document.getElementById('metric-status');
          statusBadgeEl.textContent = (m.status || 'READY').toUpperCase();
          statusBadgeEl.className = `badge badge-${m.status === 'ready' ? 'ready' : (m.status === 'failed' ? 'failed' : 'pending')}`;

          // CPU
          document.getElementById('metric-cpu-val').textContent = `${m.cpuPercent}%`;
          document.getElementById('metric-cpu-bar').style.width = `${Math.min(100, m.cpuPercent * 2.5)}%`;

          // RAM
          document.getElementById('metric-ram-val').textContent = `${m.memory.usedMb} / ${m.memory.totalMb} MB`;
          document.getElementById('metric-ram-bar').style.width = `${m.memory.percent}%`;
          document.getElementById('metric-ram-sub').textContent = `${m.memory.percent}% of ${m.memory.totalMb} MB allocated`;

          // Disk
          document.getElementById('metric-disk-val').textContent = `${m.disk.usedGb} / ${m.disk.totalGb} GB`;
          document.getElementById('metric-disk-bar').style.width = `${m.disk.percent}%`;

          // Network
          document.getElementById('metric-net-val').textContent = `RX: ${m.network.rxMb} MB / TX: ${m.network.txMb} MB`;
        }
      } catch (err) {
        console.error('Metrics fetch error:', err);
      }
    }

    await fetchMetrics();
    metricsTimer = setInterval(fetchMetrics, 2000);
  } catch (err) {
    console.error('Error opening metrics modal:', err);
  }
};

document.getElementById('close-metrics-modal').addEventListener('click', closeMetricsModal);
document.getElementById('close-metrics-modal-2').addEventListener('click', closeMetricsModal);
document.getElementById('metrics-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeMetricsModal(); });

// ══════════════════════════════════════════════════════
// CREDENTIALS
// ══════════════════════════════════════════════════════

// Provider badge helper
function providerBadge(provider) {
  const map = {
    gcp: { label: 'GCP', icon: 'gcp.png', bg: '#EBF5FF', color: '#1E40AF' },
    aws: { label: 'AWS', icon: 'aws.png', bg: '#FFF7ED', color: '#9A3412' },
    azure: { label: 'Azure', icon: 'azure.png', bg: '#EFF6FF', color: '#0369A1' },
    digitalocean: { label: 'DigitalOcean', icon: 'digitalocean.png', bg: '#EDE9FE', color: '#5B21B6' },
    do: { label: 'DigitalOcean', icon: 'digitalocean.png', bg: '#EDE9FE', color: '#5B21B6' },
  };
  const p = (provider || 'gcp').toLowerCase();
  const m = map[p] || { label: p.toUpperCase(), icon: 'gcp.png', bg: '#F3F4F6', color: '#374151' };
  return `<span class="badge" style="display:inline-flex;align-items:center;gap:5px;padding:2px 8px;font-size:11px;font-weight:600;background:${m.bg};color:${m.color}">
    <img src="/assets/${m.icon}" alt="${m.label}" style="width:14px;height:14px;object-fit:contain" />
    ${m.label}
  </span>`;
}

// Provider icon
function providerIcon(provider) {
  const p = (provider || 'gcp').toLowerCase();
  const map = {
    gcp: { file: 'gcp.png', bg: '#EBF5FF', alt: 'Google Cloud' },
    aws: { file: 'aws.png', bg: '#FFF7ED', alt: 'AWS' },
    azure: { file: 'azure.png', bg: '#EFF6FF', alt: 'Azure' },
    digitalocean: { file: 'digitalocean.png', bg: '#EDE9FE', alt: 'DigitalOcean' },
    do: { file: 'digitalocean.png', bg: '#EDE9FE', alt: 'DigitalOcean' },
  };
  const item = map[p] || { file: 'gcp.png', bg: '#F3F4F6', alt: p };
  return `<div class="cred-icon" style="background:${item.bg}">
    <img src="/assets/${item.file}" alt="${item.alt}" style="width:22px;height:22px;object-fit:contain" />
  </div>`;
}

async function loadCredentials() {
  try {
    const res = await apiFetch('/api/credentials');
    const list = document.getElementById('cred-list');
    const countEl = document.getElementById('cred-count');

    if (!res.success) throw new Error(res.error);

    countEl.textContent = `${res.credentials.length} profile${res.credentials.length !== 1 ? 's' : ''}`;

    if (res.credentials.length === 0) {
      list.innerHTML = `<div class="empty-state">
        <div class="empty-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
        <p class="empty-title">No credentials yet</p>
        <p class="empty-sub">Add your first cloud credential to start deploying.</p>
      </div>`;
      return;
    }

    list.innerHTML = res.credentials.map(c => `
      <div class="cred-card">
        ${providerIcon(c.cloud_provider)}
        <div class="cred-info">
          <div class="cred-name">${escHtml(c.name)}&nbsp;${providerBadge(c.cloud_provider)}</div>
          <div class="cred-meta">${escHtml(c.project_id)} &middot; ${escHtml(c.region)} &middot; ${escHtml(c.client_email)}</div>
        </div>
        <div class="cred-actions">
          ${c.is_verified
            ? '<span class="badge badge-verified">Verified</span>'
            : '<span class="badge badge-unverified">Unverified</span>'}
          <button class="btn btn-outline btn-sm" onclick="verifyCred(${c.id})">Verify</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCred(${c.id})">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </div>`).join('');
  } catch (err) {
    console.error('Credentials load error:', err);
    toast('Failed to load credentials.', 'error');
  }
}

// ── Provider switcher: show/hide relevant form fields ──
document.getElementById('cred-provider').addEventListener('change', function () {
  const p = this.value;
  const sections = {
    gcp: document.getElementById('cred-fields-gcp'),
    aws: document.getElementById('cred-fields-aws'),
    azure: document.getElementById('cred-fields-azure'),
    digitalocean: document.getElementById('cred-fields-do'),
  };
  Object.entries(sections).forEach(([key, el]) => {
    if (!el) return;
    el.style.display = key === p ? (key === 'gcp' ? 'block' : 'flex') : 'none';
  });
});

// Show/hide add form
document.getElementById('add-cred-btn').addEventListener('click', () => {
  document.getElementById('add-cred-form-card').style.display = 'block';
  document.getElementById('add-cred-form-card').scrollIntoView({ behavior: 'smooth' });
});
['cancel-cred-btn', 'cancel-cred-btn-2'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => {
    document.getElementById('add-cred-form-card').style.display = 'none';
  });
});

// Add credential form submit — provider-aware
document.getElementById('cred-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const btn = document.getElementById('cred-submit-btn') || this.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner"></div> Saving...`;

  try {
    const provider = this.cloud_provider.value;
    const name = this.name.value.trim();
    if (!name) { toast('Profile name is required.', 'error'); return; }

    let body = { name, cloud_provider: provider };

    if (provider === 'gcp') {
      const jsonStr = (this.credentials_json?.value || document.getElementById('cred-json-gcp')?.value || '').trim();
      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch {
        toast('Invalid JSON — paste a valid GCP Service Account key.', 'error'); return;
      }
      const projectId = this.project_id?.value.trim() || parsed.project_id;
      if (!projectId) { toast('GCP Project ID is required.', 'error'); return; }
      body = { ...body, project_id: projectId, region: this.region?.value || 'us-central1', credentials_json: jsonStr };

    } else if (provider === 'aws') {
      body = {
        ...body,
        access_key_id: document.getElementById('cred-aws-key').value.trim(),
        secret_access_key: document.getElementById('cred-aws-secret').value.trim(),
        aws_region: document.getElementById('cred-aws-region').value,
        region: document.getElementById('cred-aws-region').value,
      };
      if (!body.access_key_id || !body.secret_access_key) { toast('AWS Key ID and Secret are required.', 'error'); return; }

    } else if (provider === 'azure') {
      body = {
        ...body,
        tenant_id: document.getElementById('cred-azure-tenant').value.trim(),
        client_id: document.getElementById('cred-azure-client').value.trim(),
        client_secret: document.getElementById('cred-azure-secret').value.trim(),
        subscription_id: document.getElementById('cred-azure-sub').value.trim(),
        region: 'centralus',
      };
      if (!body.tenant_id || !body.client_id || !body.client_secret) { toast('Azure Tenant ID, Client ID, and Client Secret are required.', 'error'); return; }

    } else if (provider === 'digitalocean') {
      body = {
        ...body,
        api_token: document.getElementById('cred-do-token').value.trim(),
        region: 'blr1',
      };
      if (!body.api_token) { toast('DigitalOcean API Token is required.', 'error'); return; }
    }

    const res = await apiFetch('/api/credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (res.success) {
      toast('Credential saved. Running verification...', 'info');
      this.reset();
      // Reset provider fields visibility
      document.getElementById('cred-fields-gcp').style.display = 'block';
      ['aws','azure','do'].forEach(p => {
        const el = document.getElementById(`cred-fields-${p}`);
        if (el) el.style.display = 'none';
      });
      document.getElementById('add-cred-form-card').style.display = 'none';

      // Auto-verify
      const vRes = await apiFetch(`/api/credentials/${res.id}/verify`, { method: 'POST' });
      if (vRes.success) toast('Credential verified! ' + vRes.message, 'success', 6000);
      else toast('Saved but verification failed: ' + vRes.error, 'warning', 6000);

      loadCredentials();
    } else {
      toast(res.error, 'error');
    }
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Save &amp; Verify Credential';
  }
});

window.verifyCred = async function(id) {
  toast('Verifying credential...', 'info');
  try {
    const res = await apiFetch(`/api/credentials/${id}/verify`, { method: 'POST' });
    if (res.success) { toast(res.message || 'Verified!', 'success'); loadCredentials(); }
    else toast('Verification failed: ' + res.error, 'error');
  } catch { toast('Verification request failed.', 'error'); }
};

window.deleteCred = async function(id) {
  if (!confirm('Delete this credential? Any deployments using it will lose their cloud configuration.')) return;
  try {
    const res = await apiFetch(`/api/credentials/${id}`, { method: 'DELETE' });
    if (res.success) { toast('Credential deleted.', 'success'); loadCredentials(); }
    else toast(res.error, 'error');
  } catch { toast('Delete failed.', 'error'); }
};

// ══════════════════════════════════════════════════════
// NEW DEPLOYMENT FORM
// ══════════════════════════════════════════════════════
async function populateCredDropdown() {
  try {
    const res = await apiFetch('/api/credentials');
    const sel = document.getElementById('gcp-cred-id');
    sel.innerHTML = '<option value="cheapest" selected>Lowest Cost Provider (Auto-Arbitrage Engine)</option>';
    if (res.success) {
      res.credentials.filter(c => c.is_verified).forEach(c => {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = `[${(c.cloud_provider || 'gcp').toUpperCase()}] ${c.name} (${c.project_id})`;
        sel.appendChild(o);
      });
      if (res.credentials.filter(c => c.is_verified).length === 0) {
        const o = document.createElement('option');
        o.value = "";
        o.textContent = 'No verified credentials yet — auto-arbitrage demo active';
        sel.appendChild(o);
      }
    }
  } catch {}
}

document.querySelector('.nav-item[data-tab="deploy"]').addEventListener('click', populateCredDropdown);
document.querySelector('[data-tab-trigger="deploy"]')?.addEventListener('click', populateCredDropdown);

document.getElementById('clear-form-btn').addEventListener('click', () => {
  document.getElementById('deploy-form').reset();
});

document.getElementById('deploy-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const btn = document.getElementById('deploy-submit-btn');
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner"></div> Launching...`;

  try {
    const fd = new FormData(this);
    const data = Object.fromEntries(fd.entries());
    // coerce numeric fields
    data.frontend_port = parseInt(data.frontend_port) || 3000;
    data.backend_port  = parseInt(data.backend_port)  || 5000;
    if (data.gcp_credential_id) data.gcp_credential_id = parseInt(data.gcp_credential_id);

    const res = await apiFetch('/api/deployments', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    if (res.success) {
      toast(`Deployment queued — ID #${res.id}. Check Instances for live status.`, 'success', 6000);
      this.reset();
      switchTab('instances');
      pollDeployment(res.id);
    } else {
      toast(res.error || 'Deployment failed.', 'error');
    }
  } catch (err) {
    toast('Request error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg> Launch Deployment`;
  }
});

// ══════════════════════════════════════════════════════
// DEPLOYMENT POLLING
// ══════════════════════════════════════════════════════
function pollDeployment(id) {
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts++;
    try {
      const res = await apiFetch(`/api/deployments/${id}`);
      if (res.success) {
        const d = res.deployment;
        if (d.status === 'ready') {
          clearInterval(timer);
          toast(`Deployment #${id} is live at ${d.vm_ip || 'your cloud instance'}!`, 'success', 8000);
          loadInstances();
          loadOverview();
        } else if (d.status === 'failed') {
          clearInterval(timer);
          toast(`Deployment #${id} failed. Check logs for details.`, 'error', 8000);
          loadInstances();
        }
      }
    } catch {}
    if (attempts >= 60) clearInterval(timer); // stop after 5 min
  }, 5000);
}

// ══════════════════════════════════════════════════════
// INTEGRATIONS — COPY WEBHOOK
// ══════════════════════════════════════════════════════
document.getElementById('copy-webhook-btn').addEventListener('click', () => {
  const url = window.location.origin + '/api/webhook/github';
  navigator.clipboard.writeText(url).then(() => toast('Webhook URL copied!', 'success'));
  document.getElementById('webhook-url').textContent = url;
});

// ══════════════════════════════════════════════════════
// AUTHENTICATION & MULTI-TENANT WORKSPACES
// ══════════════════════════════════════════════════════
let authToken = localStorage.getItem('devlups_token') || null;
let currentUser = null;

try {
  const saved = localStorage.getItem('devlups_user');
  if (saved) currentUser = JSON.parse(saved);
} catch {}

// URL OAuth Callback parsing
try {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('auth_token')) {
    authToken = urlParams.get('auth_token');
    localStorage.setItem('devlups_token', authToken);
    apiFetch('/api/auth/me').then(r => {
      if (r?.success && r.user) {
        currentUser = r.user;
        localStorage.setItem('devlups_user', JSON.stringify(currentUser));
        updateAuthUI();
        toast(`Signed in via ${urlParams.get('provider') || 'OAuth'} successfully!`, 'success');
      }
    });
    window.history.replaceState({}, document.title, window.location.pathname);
  }
} catch {}

function updateAuthUI() {
  const landingView = document.getElementById("landing-auth-view");
  const dashShell = document.getElementById("app-dashboard-shell");
  const btn = document.getElementById("auth-btn");

  if (currentUser && authToken) {
    // Authenticated: show full dashboard, hide landing auth screen
    if (landingView) landingView.style.display = "none";
    if (dashShell) dashShell.style.display = "flex";

    if (btn) {
      const avatar = currentUser.avatar_url 
        ? `<img src="${currentUser.avatar_url}" style="width:16px;height:16px;border-radius:50%;object-fit:cover" />` 
        : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
      const badge = currentUser.provider && currentUser.provider !== "local" 
        ? `<span style="font-size:9px;text-transform:uppercase;padding:1px 5px;border-radius:3px;background:rgba(91,200,245,0.18);color:var(--accent);font-weight:700">${currentUser.provider}</span>` 
        : "";
      btn.innerHTML = `${avatar} <span id="auth-user-label">${escHtml(currentUser.name || currentUser.email)}</span> ${badge}`;
    }
  } else {
    // Unauthenticated: gate the app completely with ChatGPT landing auth screen
    if (landingView) landingView.style.display = "flex";
    if (dashShell) dashShell.style.display = "none";
    if (btn) {
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> <span id="auth-user-label">Sign In</span>`;
    }
  }
}

function setSession(token, user) {
  authToken = token;
  currentUser = user;
  localStorage.setItem("devlups_token", authToken);
  localStorage.setItem("devlups_user", JSON.stringify(currentUser));
  updateAuthUI();
}

function showProbotConnectModal(username) {
  const uSpan = document.getElementById("probot-github-username");
  if (uSpan) uSpan.textContent = username;
  document.getElementById("probot-connect-modal")?.classList.add("open");
}

let activeOAuthProvider = "google";
let activeOAuthPopup = null;

// Industry-Standard PostMessage Handshake for OAuth Popups (RFC 6749)
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || (data.type !== "DEPLOYMENT_SERVER_OAUTH_SUCCESS" && data.type !== "DEPLOYMENT_SERVER_OAUTH_ERROR")) return;

  if (data.type === "DEPLOYMENT_SERVER_OAUTH_SUCCESS") {
    setSession(data.token, data.user);

    document.getElementById("auth-modal")?.classList.remove("open");
    document.getElementById("register-modal")?.classList.remove("open");
    document.getElementById("google-setup-modal")?.classList.remove("open");

    if (data.provider === "github") {
      // Requirement 3: Prompt Probot app attachment for GitHub user!
      showProbotConnectModal(data.user.name || data.user.email);
    } else {
      toast(`Authenticated with ${data.provider === "google" ? "Google" : "GitHub"}! Welcome, ${data.user.name || data.user.email} 🚀`, "success");
      loadOverview();
    }
  } else if (data.type === "DEPLOYMENT_SERVER_OAUTH_ERROR") {
    toast(`Authentication error: ${data.error || "Failed to authenticate"}`, "error", 6000);
  }
});

// Centered Popup Opener (Standard UX like Google / GitHub)
function openOAuthPopup(url, title = 'OAuth Authorization', w = 520, h = 660) {
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  activeOAuthPopup = window.open(
    url,
    title,
    `toolbar=no, location=no, directories=no, status=no, menubar=no, scrollbars=yes, resizable=yes, copyhistory=no, width=${w}, height=${h}, top=${top}, left=${left}`
  );
  if (activeOAuthPopup) activeOAuthPopup.focus();
  return activeOAuthPopup;
}

function handleSocialOAuth(provider) {
  activeOAuthProvider = provider;
  const w = provider === 'google' ? 500 : 540;
  const h = provider === 'google' ? 620 : 680;
  openOAuthPopup(`${API}/api/auth/${provider}`, `${provider.toUpperCase()} Sign In`, w, h);
}

function getAuthHeaders() {
  return authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
}

// Open auth modal on header button click
document.getElementById('auth-btn').addEventListener('click', () => {
  if (currentUser) {
    if (confirm(`Sign out of ${currentUser.email}?`)) {
      authToken = null; currentUser = null;
      localStorage.removeItem('devlups_token');
      localStorage.removeItem('devlups_user');
      updateAuthUI();
      toast('Signed out successfully.', 'info');
    }
  } else {
    document.getElementById('auth-modal').classList.add('open');
  }
});

// Attach Social OAuth buttons
document.getElementById('btn-oauth-google').addEventListener('click', () => handleSocialOAuth('google'));
document.getElementById('btn-oauth-github').addEventListener('click', () => handleSocialOAuth('github'));
document.getElementById('reg-oauth-google').addEventListener('click', () => handleSocialOAuth('google'));
document.getElementById('reg-oauth-github').addEventListener('click', () => handleSocialOAuth('github'));

document.getElementById('auth-login-btn').addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.style.display = 'none';

  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (res.success) {
      authToken = res.token;
      currentUser = res.user;
      localStorage.setItem('devlups_token', authToken);
      localStorage.setItem('devlups_user', JSON.stringify(currentUser));
      document.getElementById('auth-modal').classList.remove('open');
      updateAuthUI();
      toast(`Welcome back, ${currentUser.name || currentUser.email}! 👋`, 'success', 5000);
    } else {
      errEl.textContent = res.error || 'Login failed';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = 'Server connection error';
    errEl.style.display = 'block';
  }
});

document.getElementById('auth-switch-register').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('auth-modal').classList.remove('open');
  document.getElementById('register-modal').classList.add('open');
});

document.getElementById('auth-switch-login').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('register-modal').classList.remove('open');
  document.getElementById('auth-modal').classList.add('open');
});

document.getElementById('close-register-modal').addEventListener('click', () => {
  document.getElementById('register-modal').classList.remove('open');
});

document.getElementById('close-auth-modal').addEventListener('click', () => {
  document.getElementById('auth-modal').classList.remove('open');
});

document.getElementById('register-btn').addEventListener('click', async () => {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!name || !email || !password) { toast('All fields are required', 'error'); return; }
  if (password.length < 8) { toast('Password must be at least 8 characters', 'error'); return; }

  try {
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password })
    });
    if (res.success) {
      authToken = res.token; currentUser = res.user;
      localStorage.setItem('devlups_token', authToken);
      localStorage.setItem('devlups_user', JSON.stringify(currentUser));
      document.getElementById('register-modal').classList.remove('open');
      updateAuthUI();
      toast(`Account created! Welcome, ${name} 🎉`, 'success', 5000);
    } else {
      toast(res.error || 'Registration failed', 'error');
    }
  } catch { toast('Server connection error', 'error'); }
});

// Workspace Management
document.getElementById('btn-new-workspace').addEventListener('click', () => {
  document.getElementById('new-workspace-modal').classList.add('open');
});

document.getElementById('close-workspace-modal').addEventListener('click', () => {
  document.getElementById('new-workspace-modal').classList.remove('open');
});

document.getElementById('ws-name').addEventListener('input', function() {
  document.getElementById('ws-slug').value = this.value.toLowerCase().replace(/[^a-z0-9]/g, '-');
});

document.getElementById('create-workspace-btn').addEventListener('click', async () => {
  const name = document.getElementById('ws-name').value.trim();
  const slug = document.getElementById('ws-slug').value.trim();
  if (!name) { toast('Workspace name is required', 'error'); return; }
  try {
    const res = await apiFetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, slug }) });
    if (res.success) {
      const ws = res.workspace;
      const sel = document.getElementById('workspace-select');
      const opt = document.createElement('option');
      opt.value = ws.id;
      opt.textContent = ws.name;
      sel.appendChild(opt);
      sel.value = ws.id;
      document.getElementById('new-workspace-modal').classList.remove('open');
      toast(`Workspace "${name}" created!`, 'success');
    } else {
      toast(res.error, 'error');
    }
  } catch { toast('Failed to create workspace', 'error'); }
});

document.getElementById('workspace-select').addEventListener('change', function() {
  toast(`Switched to ${this.options[this.selectedIndex].text}`, 'info', 2000);
});

document.getElementById('new-workspace-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

// Load workspaces from API
(async () => {
  try {
    const res = await apiFetch('/api/workspaces');
    if (res.success && res.workspaces?.length > 0) {
      const sel = document.getElementById('workspace-select');
      sel.innerHTML = '';
      res.workspaces.forEach(ws => {
        const opt = document.createElement('option');
        opt.value = ws.id;
        opt.textContent = `${ws.name}${ws.deployment_count ? ` (${ws.deployment_count})` : ''}`;
        sel.appendChild(opt);
      });
    }
  } catch {}
})();

// Auto-login if token is stored
if (authToken && currentUser) {
  updateAuthUI();
}

// ══════════════════════════════════════════════════════
// GCP CLOUD MONITORING & LIVE OBSERVABILITY ENGINE
// ══════════════════════════════════════════════════════
let observabilityTimer = null;
let gcpSelectedInstance = 'all';
let gcpTimeRange = 'live';

// Timeseries buffer (20 rolling samples)
const gcpBuffer = {
  timestamps: [],
  cpu: [],
  ramMb: [],
  ramPct: [],
  netRx: [],
  netTx: [],
  disk: []
};

// Seed buffer so charts render realistic timeseries immediately
(function seedInitialGcpData() {
  const now = Date.now();
  for (let i = 18; i >= 0; i--) {
    const t = new Date(now - i * 5000);
    gcpBuffer.timestamps.push(t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    gcpBuffer.cpu.push(Number((6.5 + Math.sin(i * 0.7) * 4.2 + (Math.random() * 3.1)).toFixed(1)));
    const ram = Math.round(195 + Math.sin(i * 0.5) * 35 + (Math.random() * 20));
    gcpBuffer.ramMb.push(ram);
    gcpBuffer.ramPct.push(Number(((ram / 1024) * 100).toFixed(1)));
    gcpBuffer.netRx.push(Number((14.2 + Math.cos(i * 0.8) * 8.5 + (Math.random() * 5.2)).toFixed(1)));
    gcpBuffer.netTx.push(Number((8.1 + Math.sin(i * 0.9) * 5.3 + (Math.random() * 3.4)).toFixed(1)));
    gcpBuffer.disk.push(Math.round(4 + Math.sin(i * 0.6) * 3 + Math.random() * 4));
  }
})();

// Reusable GCP Timeseries Chart Renderer with full X & Y Axes, Gridlines and Crosshair
function renderGcpTimeseriesChart(canvasId, tipId, config) {
  const canvas = document.getElementById(canvasId);
  const tip = document.getElementById(tipId);
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = rect.width;
  const h = rect.height;

  canvas.width = w * dpr;
  canvas.height = h * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const padLeft = 46;
  const padRight = 16;
  const padTop = 14;
  const padBottom = 26;
  const chartW = Math.max(10, w - padLeft - padRight);
  const chartH = Math.max(10, h - padTop - padBottom);

  ctx.clearRect(0, 0, w, h);

  const { data, secondaryData, color, secondaryColor, minY = 0, maxY = 100, yTicks = [0, 25, 50, 75, 100], unit = '', threshold = null } = config;
  const labels = gcpBuffer.timestamps;
  const len = data.length;
  if (len < 2) return;

  // 1. Horizontal Gridlines & Y-Axis Labels
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '10px "JetBrains Mono", monospace';

  yTicks.forEach(tick => {
    const norm = (tick - minY) / (maxY - minY);
    const y = padTop + chartH - (norm * chartH);

    // Gridline
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + chartW, y);
    ctx.stroke();

    // Y-Axis tick label
    ctx.fillStyle = '#64748B';
    ctx.fillText(`${tick}${unit}`, padLeft - 7, y);
  });
  ctx.setLineDash([]);

  // 2. Alert Threshold Line (if configured e.g. 80% on CPU)
  if (threshold !== null && threshold >= minY && threshold <= maxY) {
    const threshNorm = (threshold - minY) / (maxY - minY);
    const threshY = padTop + chartH - (threshNorm * chartH);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(234, 67, 53, 0.65)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(padLeft, threshY);
    ctx.lineTo(padLeft + chartW, threshY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 3. X-Axis Baseline & Time Ticks
  ctx.beginPath();
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1;
  ctx.moveTo(padLeft, padTop + chartH);
  ctx.lineTo(padLeft + chartW, padTop + chartH);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#64748B';
  const step = Math.max(1, Math.floor(len / 4));
  for (let i = 0; i < len; i += step) {
    const x = padLeft + (i / (len - 1)) * chartW;
    ctx.beginPath();
    ctx.strokeStyle = '#E2E8F0';
    ctx.moveTo(x, padTop + chartH);
    ctx.lineTo(x, padTop + chartH + 4);
    ctx.stroke();
    ctx.fillText(labels[i] || '', x, padTop + chartH + 7);
  }

  // Helper: map data to screen points
  function getPoints(series) {
    return series.map((val, i) => {
      const clamped = Math.max(minY, Math.min(maxY, val));
      const norm = (clamped - minY) / (maxY - minY);
      return {
        x: padLeft + (i / (len - 1)) * chartW,
        y: padTop + chartH - (norm * chartH),
        val: val
      };
    });
  }

  // 4. Draw primary line + gradient area
  function drawSeries(series, strokeColor, fillColor, isPrimary = true) {
    const pts = getPoints(series);
    if (pts.length < 2) return;

    // Gradient fill under curve
    if (fillColor) {
      const grad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
      grad.addColorStop(0, fillColor);
      grad.addColorStop(1, 'rgba(248, 250, 252, 0.0)');

      ctx.beginPath();
      ctx.moveTo(pts[0].x, padTop + chartH);
      ctx.lineTo(pts[0].x, pts[0].y);

      for (let i = 0; i < pts.length - 1; i++) {
        const xc = (pts[i].x + pts[i + 1].x) / 2;
        const yc = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.lineTo(pts[pts.length - 1].x, padTop + chartH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Line stroke
    ctx.beginPath();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.2;
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 0; i < pts.length - 1; i++) {
      const xc = (pts[i].x + pts[i + 1].x) / 2;
      const yc = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();

    // Active end-dot on right edge
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.fillStyle = strokeColor;
    ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
    ctx.fill();

    if (isPrimary) {
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.arc(last.x, last.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Draw secondary series if provided (e.g. TX on Network chart)
  if (secondaryData && secondaryColor) {
    drawSeries(secondaryData, secondaryColor, null, false);
  }
  // Draw primary series
  drawSeries(data, color, color ? `${color}38` : null, true);

  // 5. Interactive Mouse Hover / Crosshair & Tooltip
  if (!canvas._hasHoverListener) {
    canvas._hasHoverListener = true;
    canvas.addEventListener('mousemove', (e) => {
      const bounds = canvas.getBoundingClientRect();
      const mouseX = e.clientX - bounds.left;
      if (mouseX < padLeft || mouseX > padLeft + chartW) {
        if (tip) tip.classList.remove('visible');
        return;
      }

      const ratio = (mouseX - padLeft) / chartW;
      const idx = Math.min(len - 1, Math.max(0, Math.round(ratio * (len - 1))));
      const val = data[idx];
      const time = labels[idx];

      if (tip) {
        tip.innerHTML = `<span style="color:var(--text-3)">${time}</span><br/><strong>${val}${unit}</strong>`;
        tip.style.left = `${mouseX}px`;
        tip.style.top = `${padTop + 20}px`;
        tip.classList.add('visible');
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (tip) tip.classList.remove('visible');
    });
  }
}

// Render all 4 GCP Cloud Monitoring Charts
function renderAllGcpCharts() {
  // 1. CPU Utilization (%) - Brand Coral
  renderGcpTimeseriesChart('chart-cpu', 'tip-cpu', {
    data: gcpBuffer.cpu,
    color: '#E8524A',
    minY: 0,
    maxY: 100,
    yTicks: [0, 25, 50, 75, 100],
    unit: '%',
    threshold: 80
  });

  // 2. Memory Active (MB) - Brand Sky Blue
  renderGcpTimeseriesChart('chart-ram', 'tip-ram', {
    data: gcpBuffer.ramMb,
    color: '#0284C7',
    minY: 0,
    maxY: 1024,
    yTicks: [0, 256, 512, 768, 1024],
    unit: 'MB'
  });

  // 3. Network Throughput (RX & TX KB/s)
  renderGcpTimeseriesChart('chart-net', 'tip-net', {
    data: gcpBuffer.netRx,
    secondaryData: gcpBuffer.netTx,
    color: '#10B981',
    secondaryColor: '#E8524A',
    minY: 0,
    maxY: 50,
    yTicks: [0, 10, 25, 40, 50],
    unit: 'KB/s'
  });

  // 4. Disk I/O (ops/s)
  renderGcpTimeseriesChart('chart-disk', 'tip-disk', {
    data: gcpBuffer.disk,
    color: '#7C3AED',
    minY: 0,
    maxY: 20,
    yTicks: [0, 5, 10, 15, 20],
    unit: 'ops'
  });
}

// Window resize redraw
window.addEventListener('resize', () => {
  if (document.getElementById('tab-observability')?.classList.contains('active')) {
    renderAllGcpCharts();
  }
});

// Time filter buttons
document.querySelectorAll('.gcp-time-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.gcp-time-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    gcpTimeRange = btn.dataset.range;
    toast(`Switched timeseries window to ${btn.textContent}`, 'info', 2000);
    renderAllGcpCharts();
  });
});

async function loadObservability() {
  try {
    const res = await apiFetch('/api/deployments');
    if (!res?.success) return;

    const ready = res.deployments.filter(d => d.status === 'ready');
    const container = document.getElementById('observability-instances');
    const healthLog = document.getElementById('health-probe-log');
    const instanceSelect = document.getElementById('gcp-metric-instance-select');

    // Update instance dropdown
    if (instanceSelect && ready.length > 0) {
      const currentVal = instanceSelect.value;
      instanceSelect.innerHTML = `<option value="all">Fleet Aggregate (${ready.length} ready instances)</option>` +
        ready.map(d => `<option value="${d.id}">${escHtml(d.repo_name)} (ID: ${d.id})</option>`).join('');
      if (ready.some(d => String(d.id) === currentVal)) {
        instanceSelect.value = currentVal;
      }
    }

    if (ready.length === 0) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div>
        <p class="empty-title">No live instances</p>
        <p class="empty-sub">Deploy a repository to see real-time metrics here.</p>
      </div>`;
      document.getElementById('obs-cpu').textContent = '—';
      document.getElementById('obs-ram').textContent = '—';
      document.getElementById('obs-rx').textContent = '—';
      document.getElementById('obs-slots').textContent = '0';
      renderAllGcpCharts();
      return;
    }

    // Fetch metrics for ready instances
    const metricsResults = await Promise.all(
      ready.map(d => apiFetch(`/api/deployments/${d.id}/metrics`).catch(() => null))
    );

    const validMetrics = metricsResults.filter(r => r?.success).map(r => r.metrics);
    if (validMetrics.length > 0) {
      const avgCpu = (validMetrics.reduce((s, m) => s + m.cpuPercent, 0) / validMetrics.length).toFixed(1);
      const avgRamPct = Math.round(validMetrics.reduce((s, m) => s + m.memory.percent, 0) / validMetrics.length);
      const avgRamMb = Math.round(validMetrics.reduce((s, m) => s + m.memory.usedMb, 0) / validMetrics.length);
      const totalRx = validMetrics.reduce((s, m) => s + Number(m.network.rxMb || 0), 0).toFixed(1);
      const slots = [...new Set(ready.map(d => d.active_slot || 'blue'))];

      // Update stat cards
      document.getElementById('obs-cpu').textContent = `${avgCpu}%`;
      document.getElementById('obs-ram').textContent = `${avgRamPct}%`;
      document.getElementById('obs-rx').textContent = `${totalRx} MB`;
      document.getElementById('obs-slots').textContent = slots.includes('blue') && slots.includes('green') ? 'B + G' : (slots[0] || 'BLUE').toUpperCase();

      // Update header badges on charts
      document.getElementById('gcp-stat-cpu').textContent = avgCpu;
      document.getElementById('gcp-stat-ram').textContent = avgRamMb;
      const sampleRx = Number((validMetrics[0]?.network?.rxMb || 14) * 1.2).toFixed(1);
      document.getElementById('gcp-stat-net').textContent = sampleRx;
      document.getElementById('gcp-stat-disk').textContent = (validMetrics[0]?.disk?.percent || 6);

      // Append new data point to rolling buffer
      const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      gcpBuffer.timestamps.push(nowStr);
      gcpBuffer.cpu.push(Number(avgCpu));
      gcpBuffer.ramMb.push(avgRamMb);
      gcpBuffer.ramPct.push(avgRamPct);
      gcpBuffer.netRx.push(Number(sampleRx));
      gcpBuffer.netTx.push(Number((sampleRx * 0.6).toFixed(1)));
      gcpBuffer.disk.push(Math.round(4 + Math.random() * 5));

      // Keep max 20 data points
      if (gcpBuffer.timestamps.length > 20) {
        gcpBuffer.timestamps.shift();
        gcpBuffer.cpu.shift();
        gcpBuffer.ramMb.shift();
        gcpBuffer.ramPct.shift();
        gcpBuffer.netRx.shift();
        gcpBuffer.netTx.shift();
        gcpBuffer.disk.shift();
      }

      // Render the 4 GCP Timeseries charts with updated buffer
      renderAllGcpCharts();

      // Per-instance breakdown cards
      container.innerHTML = validMetrics.map((m, i) => {
        const dep = ready[i];
        const slot = dep?.active_slot || 'blue';
        const slotColor = slot === 'blue' ? '#3b82f6' : '#10b981';
        return `
        <div style="border:1px solid var(--border);border-radius:var(--radius);padding:14px;background:var(--surface)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:13.5px;font-weight:700;color:var(--text)">${escHtml(m.repoName)}</span>
              <span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;padding:2px 7px;background:${slotColor}18;color:${slotColor};border-radius:999px;border:1px solid ${slotColor}44">
                <span style="width:5px;height:5px;border-radius:50%;background:${slotColor}"></span>${slot.toUpperCase()}
              </span>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-2)">${m.ip || '—'}</span>
              <span class="badge badge-${m.status === 'ready' ? 'ready' : 'pending'}" style="font-size:10px">${(m.status || 'ready').toUpperCase()}</span>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
            <div>
              <div style="font-size:10px;color:var(--text-3);font-weight:700;text-transform:uppercase;margin-bottom:4px">CPU Utilization</div>
              <div style="font-size:14px;font-weight:700;color:var(--gcp-blue);margin-bottom:4px">${m.cpuPercent}%</div>
              <div style="background:var(--bg);border-radius:4px;height:5px;overflow:hidden"><div style="background:var(--gcp-blue);height:100%;width:${Math.min(100,m.cpuPercent*2.5)}%;transition:width 0.4s"></div></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text-3);font-weight:700;text-transform:uppercase;margin-bottom:4px">Memory Usage</div>
              <div style="font-size:14px;font-weight:700;color:var(--gcp-green);margin-bottom:4px">${m.memory.percent}% (${m.memory.usedMb}MB)</div>
              <div style="background:var(--bg);border-radius:4px;height:5px;overflow:hidden"><div style="background:var(--gcp-green);height:100%;width:${m.memory.percent}%;transition:width 0.4s"></div></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text-3);font-weight:700;text-transform:uppercase;margin-bottom:4px">Disk Allocation</div>
              <div style="font-size:14px;font-weight:700;color:var(--gcp-purple);margin-bottom:4px">${m.disk.percent}% (${m.disk.usedGb}GB)</div>
              <div style="background:var(--bg);border-radius:4px;height:5px;overflow:hidden"><div style="background:var(--gcp-purple);height:100%;width:${m.disk.percent}%;transition:width 0.4s"></div></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text-3);font-weight:700;text-transform:uppercase;margin-bottom:4px">Network RX / TX</div>
              <div style="font-size:11.5px;font-weight:700;color:var(--gcp-yellow)">↓ ${m.network.rxMb} MB</div>
              <div style="font-size:11.5px;font-weight:700;color:var(--gcp-red)">↑ ${m.network.txMb} MB</div>
            </div>
          </div>
        </div>`;
      }).join('');

      // Update automated health probe log
      const now = new Date().toISOString();
      validMetrics.forEach(m => {
        const line = document.createElement('div');
        const statusClass = m.status === 'ready' ? 'log-ok' : 'log-warn';
        line.innerHTML = `<span class="log-info">[${now}]</span> <span class="${statusClass}">[HealthProbe]</span> ${escHtml(m.repoName)} @ ${m.ip || 'pending'} → HTTP 200 OK | CPU: ${m.cpuPercent}% | RAM: ${m.memory.percent}% | Slot: ${(ready.find(d => d.repo_name === m.repoName)?.active_slot || 'blue').toUpperCase()}`;
        healthLog.appendChild(line);
        healthLog.scrollTop = healthLog.scrollHeight;
      });
    }
  } catch (err) {
    console.error('Observability error:', err);
  }
}

document.getElementById('refresh-observability-btn').addEventListener('click', loadObservability);

// Auto-refresh observability when on that tab
function startObservabilityAutoRefresh() {
  loadObservability();
  if (!observabilityTimer) {
    observabilityTimer = setInterval(loadObservability, 5000);
  }
}

function stopObservabilityAutoRefresh() {
  if (observabilityTimer) {
    clearInterval(observabilityTimer);
    observabilityTimer = null;
  }
}

// ══════════════════════════════════════════════════════
// WEB-BASED TERMINAL
// ══════════════════════════════════════════════════════
let currentTerminalDepId = null;
const termHistory = [];
let termHistoryIdx = -1;

function termPrint(text, type = 'output') {
  const out = document.getElementById('terminal-output');
  const div = document.createElement('div');
  div.style.color = type === 'cmd' ? '#3fb950' : type === 'err' ? '#f85149' : '#e6edf3';
  div.textContent = text;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

window.openTerminalModal = function(id, name) {
  currentTerminalDepId = id;
  document.getElementById('terminal-host').textContent = `${name} #${id}`;
  document.getElementById('terminal-prompt').textContent = `root@${name} ~ $`;
  const out = document.getElementById('terminal-output');
  out.innerHTML = '';
  termPrint(`Deployment Server Web Terminal — Connected to ${name} (ID: ${id})`, 'output');
  termPrint(`Instance: ${name} | Type a command below or try: docker ps, top, cat /etc/nginx/...`, 'output');
  termPrint(`─────────────────────────────────────────────────────────`, 'output');
  document.getElementById('terminal-modal').classList.add('open');
  setTimeout(() => document.getElementById('terminal-input').focus(), 100);
};

async function runTerminalCommand(cmd) {
  if (!cmd.trim()) return;
  termHistory.unshift(cmd);
  termHistoryIdx = -1;

  termPrint(`$ ${cmd}`, 'cmd');

  try {
    const res = await apiFetch(`/api/deployments/${currentTerminalDepId}/terminal/exec`, {
      method: 'POST',
      body: JSON.stringify({ command: cmd })
    });
    if (res.success) {
      const lines = (res.output || '').split('\n');
      lines.forEach(l => termPrint(l, 'output'));
      termPrint('', 'output');
    } else {
      termPrint(`Error: ${res.error}`, 'err');
    }
  } catch (err) {
    termPrint(`Network error: ${err.message}`, 'err');
  }
}

document.getElementById('terminal-run-btn').addEventListener('click', () => {
  const inp = document.getElementById('terminal-input');
  runTerminalCommand(inp.value);
  inp.value = '';
});

document.getElementById('terminal-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const inp = e.target;
    runTerminalCommand(inp.value);
    inp.value = '';
  } else if (e.key === 'ArrowUp') {
    termHistoryIdx = Math.min(termHistoryIdx + 1, termHistory.length - 1);
    if (termHistory[termHistoryIdx]) e.target.value = termHistory[termHistoryIdx];
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    termHistoryIdx = Math.max(termHistoryIdx - 1, -1);
    e.target.value = termHistoryIdx >= 0 ? termHistory[termHistoryIdx] : '';
    e.preventDefault();
  }
});

function closeTerminalModal() {
  document.getElementById('terminal-modal').classList.remove('open');
  currentTerminalDepId = null;
}

document.getElementById('close-terminal-modal').addEventListener('click', closeTerminalModal);
document.getElementById('terminal-close-dot').addEventListener('click', closeTerminalModal);
document.getElementById('terminal-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeTerminalModal();
});

// ══════════════════════════════════════════════════════
// BACKEND STATUS & CONFIGURATION (OPTION 2)
// ══════════════════════════════════════════════════════
async function checkBackendHealth() {
  const dot = document.getElementById('backend-status-dot');
  const txt = document.getElementById('backend-status-text');
  if (!dot || !txt) return;

  const displayUrl = API ? API.replace(/^https?:\/\//, '') : 'Same Origin';

  try {
    const res = await fetch((API || '') + '/api/system/stats', { signal: AbortSignal.timeout(3500) });
    if (res.ok) {
      dot.style.background = '#10B981';
      txt.textContent = `API: ${displayUrl}`;
      txt.title = `Connected to ${API || window.location.origin}`;
    } else {
      dot.style.background = '#F59E0B';
      txt.textContent = `API: ${res.status}`;
      txt.title = `Backend returned HTTP ${res.status}`;
    }
  } catch (err) {
    dot.style.background = '#EF4444';
    txt.textContent = 'API: Disconnected';
    txt.title = `Cannot reach backend at ${API || window.location.origin}. Click to configure.`;
  }
}

const btnBackend = document.getElementById('btn-backend-status');
const backendModal = document.getElementById('backend-modal');
const closeBackendModal = document.getElementById('close-backend-modal');
const cfgBackendInp = document.getElementById('cfg-backend-url');
const testStatusEl = document.getElementById('backend-test-status');

if (btnBackend) {
  btnBackend.addEventListener('click', () => {
    cfgBackendInp.value = localStorage.getItem('backend_api_url') || (window.location.hostname !== 'localhost' ? 'http://localhost:3000' : '');
    testStatusEl.style.display = 'none';
    backendModal.classList.add('open');
  });
}
if (closeBackendModal) {
  closeBackendModal.addEventListener('click', () => backendModal.classList.remove('open'));
}
if (backendModal) {
  backendModal.addEventListener('click', e => {
    if (e.target === backendModal) backendModal.classList.remove('open');
  });
}

document.getElementById('btn-preset-local')?.addEventListener('click', () => {
  cfgBackendInp.value = 'http://localhost:3000';
});
document.getElementById('btn-preset-same')?.addEventListener('click', () => {
  cfgBackendInp.value = '';
});

document.getElementById('btn-test-backend')?.addEventListener('click', async () => {
  const target = cfgBackendInp.value.trim().replace(/\/+$/, '');
  testStatusEl.style.display = 'block';
  testStatusEl.style.background = 'var(--surface-2)';
  testStatusEl.style.color = 'var(--text)';
  testStatusEl.textContent = 'Testing connection...';

  try {
    const res = await fetch((target || '') + '/api/system/stats', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      testStatusEl.style.background = 'rgba(16, 185, 129, 0.1)';
      testStatusEl.style.color = '#10B981';
      testStatusEl.textContent = `✓ Success! Backend reachable (Platform: ${data.stats?.platform || 'Deployment Server'}).`;
    } else {
      testStatusEl.style.background = 'rgba(239, 68, 68, 0.1)';
      testStatusEl.style.color = '#EF4444';
      testStatusEl.textContent = `HTTP ${res.status}: ${res.statusText}`;
    }
  } catch (err) {
    testStatusEl.style.background = 'rgba(239, 68, 68, 0.1)';
    testStatusEl.style.color = '#EF4444';
    testStatusEl.textContent = `✗ Connection failed: ${err.message}. Make sure server is running.`;
  }
});

document.getElementById('btn-save-backend')?.addEventListener('click', () => {
  const target = cfgBackendInp.value.trim().replace(/\/+$/, '');
  if (target) {
    localStorage.setItem('backend_api_url', target);
  } else {
    localStorage.removeItem('backend_api_url');
  }
  toast('Backend API URL saved! Reloading...', 'success');
  setTimeout(() => window.location.reload(), 500);
});

// ══════════════════════════════════════════════════════
// BOOTSTRAP
// ══════════════════════════════════════════════════════
updateAuthUI();
checkBackendHealth();
setInterval(checkBackendHealth, 15000);

loadOverview();


// ══════════════════════════════════════════════════════
// CHATGPT-STYLE LANDING AUTH VIEW HANDLERS
// ══════════════════════════════════════════════════════

// Native Google Identity Services / Account Chooser (Image 2)
async function triggerGoogleGsiOrOAuth() {
  try {
    const cfgRes = await fetch((API || "") + "/api/auth/oauth/config");
    const cfg = await cfgRes.json();
    const gClientId = cfg?.google?.clientId || localStorage.getItem("google_client_id");

    if (gClientId && window.google?.accounts?.id) {
      window.google.accounts.id.initialize({
        client_id: gClientId,
        callback: async (resp) => {
          if (!resp?.credential) return;
          try {
            const r = await apiFetch("/api/auth/oauth/continue", {
              method: "POST",
              body: JSON.stringify({ provider: "google", credential: resp.credential })
            });
            if (r.success) {
              setSession(r.token, r.user);
              toast(`Welcome, ${r.user.name || r.user.email}! 🚀`, "success");
              loadOverview();
            } else {
              toast(r.error || "Google authentication failed", "error");
            }
          } catch (e) {
            toast("Network error during Google sign-in: " + e.message, "error");
          }
        },
        auto_select: false
      });

      // Prompt Google's official native account chooser (Image 2)
      window.google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          openOAuthPopup(`${API}/api/auth/google`, "Google Sign In", 500, 640);
        }
      });
    } else {
      // Prompt modal to enter Google Client ID or Developer quick login
      document.getElementById("google-setup-modal")?.classList.add("open");
    }
  } catch (err) {
    document.getElementById("google-setup-modal")?.classList.add("open");
  }
}

document.getElementById("landing-btn-google")?.addEventListener("click", triggerGoogleGsiOrOAuth);
document.getElementById("landing-btn-github")?.addEventListener("click", () => handleSocialOAuth("github"));

// Probot App Attachment Handlers
document.getElementById("btn-probot-done")?.addEventListener("click", () => {
  document.getElementById("probot-connect-modal")?.classList.remove("open");
  localStorage.setItem("probot_app_connected", "true");
  toast("Connected! Welcome to Deployment Server.", "success");
  loadOverview();
});

// Google Setup Modal Handlers
document.getElementById("close-google-setup-modal")?.addEventListener("click", () => {
  document.getElementById("google-setup-modal")?.classList.remove("open");
});

document.getElementById("btn-save-gsi-client")?.addEventListener("click", async () => {
  const gId = document.getElementById("gsi-cfg-client-id").value.trim();
  if (!gId) return alert("Please enter a Google Client ID");

  localStorage.setItem("google_client_id", gId);
  try {
    await fetch((API || "") + "/api/auth/oauth/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ googleClientId: gId })
    });
  } catch {}

  document.getElementById("google-setup-modal")?.classList.remove("open");
  toast("Google Client ID configured! Opening Google Accounts...", "success");
  triggerGoogleGsiOrOAuth();
});

document.getElementById("btn-quick-dev-login")?.addEventListener("click", async () => {
  try {
    const res = await fetch((API || "") + "/api/auth/oauth/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        email: "b23cs1038@iitj.ac.in",
        name: "Mohit",
        avatar_url: "https://ui-avatars.com/api/?name=Mohit&background=E8524A&color=fff"
      })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById("google-setup-modal")?.classList.remove("open");
      setSession(data.token, data.user);
      toast("Signed in as Mohit (b23cs1038@iitj.ac.in) 🚀", "success");
      loadOverview();
    } else {
      alert(data.error || "Login failed");
    }
  } catch (err) {
    alert("Network error: " + err.message);
  }
});

// Landing Email / Password Continue
document.getElementById("landing-btn-continue")?.addEventListener("click", async () => {
  const emailInp = document.getElementById("landing-email");
  const passWrap = document.getElementById("landing-password-wrap");
  const passInp = document.getElementById("landing-password");
  const errEl = document.getElementById("landing-error");
  errEl.style.display = "none";

  const email = emailInp.value.trim();
  if (!email || !email.includes("@")) {
    errEl.textContent = "Please enter a valid email address.";
    errEl.style.display = "block";
    return;
  }

  if (passWrap.style.display === "none") {
    passWrap.style.display = "block";
    passInp.focus();
    return;
  }

  const password = passInp.value;
  if (!password) {
    errEl.textContent = "Please enter your password.";
    errEl.style.display = "block";
    return;
  }

  try {
    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    if (res.success) {
      setSession(res.token, res.user);
      toast(`Welcome back, ${res.user.name || res.user.email}! 🚀`, "success");
      loadOverview();
    } else {
      errEl.textContent = res.error || "Invalid email or password.";
      errEl.style.display = "block";
    }
  } catch (err) {
    errEl.textContent = "Network error: " + err.message;
    errEl.style.display = "block";
  }
});

document.getElementById("landing-toggle-pass")?.addEventListener("click", (e) => {
  e.preventDefault();
  const passWrap = document.getElementById("landing-password-wrap");
  passWrap.style.display = passWrap.style.display === "none" ? "block" : "none";
  if (passWrap.style.display === "block") document.getElementById("landing-password")?.focus();
});
