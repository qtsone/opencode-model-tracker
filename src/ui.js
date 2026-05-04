// src/ui.js

function buildScript(token) {
  // Token is embedded as a JS string literal. It contains only hex chars (crypto random)
  // so no escaping is needed. Validated at call site.
  return `
var _registry = null;
var _syncStatus = null;
var _agents = [];
var _editingModelId = null;
var _isNewModel = false;
var _pendingAssignments = null;
var _parentPage = 1;
var _parentPageSize = 50;
var _parentTotalPages = 1;
var _agentPage = 1;
var _agentPageSize = 50;
var _agentTotalPages = 1;
var _expandedRows = {};
var _timeRange = '1h';
var _adminToken = '${token}';

function showPage(name) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('nav a').forEach(function(a) { a.classList.remove('active'); });
  document.getElementById('page-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');
  if (name === 'registry')    loadRegistryPage();
  if (name === 'assignments') loadAssignments();
  if (name === 'stats')       loadStats();
}

function fmt(v, d) {
  d = d === undefined ? 2 : d;
  return (v == null) ? '—' : Number(v).toFixed(d);
}
function fmtDur(ms) {
  if (ms == null || isNaN(+ms)) return '—';
  var s = Math.floor(+ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}
function fmtTokens(value) {
  if (value == null || isNaN(+value)) return '—';
  var n = +value;
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return Math.round(n).toLocaleString('en-US');
}
function scoreClass(v) {
  if (v == null) return '';
  return v >= 0.6 ? 'score-high' : v >= 0.35 ? 'score-mid' : 'score-low';
}
function apiFetch(path, opts) {
  return fetch(path, opts).then(function(r) {
    return r.json().then(function(data) {
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    });
  });
}
function adminFetch(path, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers['x-model-tracker-admin-token'] = _adminToken;
  return apiFetch(path, opts);
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function truncateLabel(s) {
  if (!s) return '\u2014';
  return s.length > 18 ? s.slice(0, 16) + '\u2026' : s;
}

function loadRegistryPage() {
  document.getElementById('reg-models-body').innerHTML = skeletonRows(6, 8);
  apiFetch('/api/registry').then(function(reg) {
    _registry = reg;
    renderRegistry();
  }).catch(function(e) {
    document.getElementById('reg-models-body').innerHTML = '<tr><td colspan="8" class="empty">Error loading registry: ' + esc(e.message) + '</td></tr>';
  });
}

function renderRegistry() {
  if (!_registry) return;
  var models = _registry.models || {};
  var tbody = document.getElementById('reg-models-body');
  var rows = Object.entries(models).map(function(entry) {
    var id = entry[0]; var m = entry[1];
    var inCost = m.cost && m.cost.input_per_1m;
    var outCost = m.cost && m.cost.output_per_1m;
    return '<tr>' +
      '<td><code>' + esc(id) + '</code></td>' +
      '<td>' + esc(m.name || '—') + '</td>' +
      '<td><span class="badge">' + esc(m.provider || '—') + '</span></td>' +
      '<td>' + (m.context_window ? (m.context_window / 1000).toFixed(0) + 'k' : '—') + '</td>' +
      '<td>' + (inCost === 'free' ? '<span class="badge">free</span>' : fmt(inCost, 4)) + '</td>' +
      '<td>' + (outCost === 'free' ? '<span class="badge">free</span>' : fmt(outCost, 4)) + '</td>' +
      '<td style="max-width:200px;font-size:.75rem;color:#94a3b8">' + esc(m.notes || '') + '</td>' +
      '<td><button class="btn btn-ghost" data-model-id="' + esc(id) + '">Edit</button></td>' +
      '</tr>';
  });
  tbody.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="8" class="empty">No models</td></tr>';
  tbody.querySelectorAll('button[data-model-id]').forEach(function(btn) {
    btn.addEventListener('click', function() { editModel(btn.dataset.modelId); });
  });
}

function openAddModel() {
  _editingModelId = null;
  _isNewModel = true;
  document.getElementById('modal-title').textContent = 'Add Model';
  document.getElementById('modal-id-group').style.display = '';
  document.getElementById('modal-new-id').value = '';
  document.getElementById('modal-json').value = JSON.stringify({
    provider: '', name: '', context_window: 128000,
    cost: {
      input_per_1m: 'free',
      cache_read_per_1m: 'free',
      cache_write_per_1m: 'free',
      output_per_1m: 'free'
    },
    strengths: [], notes: ''
  }, null, 2);
  document.getElementById('modal-error').textContent = '';
  document.getElementById('modal-delete-btn').style.display = 'none';
  var saveBtn = document.getElementById('modal-save-btn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  document.getElementById('model-modal').classList.add('open');
}

function editModel(id) {
  _editingModelId = id;
  _isNewModel = false;
  var model = _registry.models[id];
  document.getElementById('modal-title').textContent = 'Edit Model: ' + id;
  document.getElementById('modal-id-group').style.display = 'none';
  document.getElementById('modal-json').value = JSON.stringify(model, null, 2);
  document.getElementById('modal-error').textContent = '';
  document.getElementById('modal-delete-btn').style.display = '';
  var saveBtn = document.getElementById('modal-save-btn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  document.getElementById('model-modal').classList.add('open');
}

function closeModal() {
  document.getElementById('model-modal').classList.remove('open');
}

function saveModel() {
  var raw = document.getElementById('modal-json').value;
  var obj;
  try { obj = JSON.parse(raw); } catch(e) {
    document.getElementById('modal-error').textContent = 'Invalid JSON: ' + e.message;
    return;
  }
  var reg = JSON.parse(JSON.stringify(_registry));
  var id = _editingModelId;
  if (_isNewModel) {
    id = (document.getElementById('modal-new-id').value || '').trim();
    if (!id) {
      document.getElementById('modal-error').textContent = 'Model ID is required.';
      document.getElementById('modal-new-id').focus();
      return;
    }
  }
  reg.models[id] = obj;
  var saveBtn = document.getElementById('modal-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  adminFetch('/api/registry', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(reg) })
    .then(function() { closeModal(); loadRegistryPage(); showToast('Model saved', 'success'); })
    .catch(function(e) {
      document.getElementById('modal-error').textContent = e.message;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    });
}

function deleteModel() {
  var modelId = _editingModelId;
  confirmAction('Delete model \u201c' + modelId + '\u201d? This cannot be undone.', function() {
    var reg = JSON.parse(JSON.stringify(_registry));
    delete reg.models[modelId];
    Object.keys(reg.agent_assignments).forEach(function(k) {
      if (reg.agent_assignments[k] === modelId) delete reg.agent_assignments[k];
    });
    adminFetch('/api/registry', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(reg) })
      .then(function() { closeModal(); loadRegistryPage(); showToast('Model deleted', 'success'); })
      .catch(function(e) { document.getElementById('modal-error').textContent = e.message; });
  });
}

function loadAssignments() {
  Promise.all([apiFetch('/api/registry'), apiFetch('/api/sync-status'), apiFetch('/api/agents')]).then(function(results) {
    _registry = results[0];
    _syncStatus = results[1];
    _agents = (results[2] && results[2].agents) || [];
    _pendingAssignments = null;
    renderAssignments();
  }).catch(function(e) {
    document.getElementById('assign-body').innerHTML = '<tr><td colspan="6" class="empty">Error loading assignments: ' + esc(e.message) + '</td></tr>';
  });
}

function renderAssignments() {
  var regAssignments = (_registry && _registry.agent_assignments) || {};
  var drift = (_syncStatus && _syncStatus.drift) || [];
  var driftMap = {};
  drift.forEach(function(d) { driftMap[d.agent] = d; });
  var models = Object.keys((_registry && _registry.models) || {});

  var rows = _agents.map(function(agent) {
    var agentName = agent.name;
    var pending = _pendingAssignments && Object.prototype.hasOwnProperty.call(_pendingAssignments, agentName)
      ? _pendingAssignments[agentName] : null;
    var regModel = regAssignments[agentName] || null;
    var selectedModel = pending !== null ? pending : (regModel || (models.indexOf(agent.model) !== -1 ? agent.model : ''));
    var d = driftMap[agentName];
    var actual = d ? d.actual : (agent.model || '—');
    var isDrift = !!d;
    var sourceLabel = agent.source === 'opencode' ? 'opencode.json' : 'agent file';
    var placeholder = '<option value="" disabled' + (selectedModel ? '' : ' selected') + '>Select model\u2026</option>';
    var opts = placeholder + models.map(function(m) {
      return '<option value="' + esc(m) + '"' + (selectedModel === m ? ' selected' : '') + '>' + esc(m) + '</option>';
    }).join('');
    return '<tr class="' + (isDrift ? 'drift' : '') + '">' +
      '<td><span class="badge">' + esc(agentName) + '</span></td>' +
      '<td><span class="badge badge-dim">' + esc(sourceLabel) + '</span></td>' +
      '<td><select class="assignment-sel" data-agent="' + esc(agentName) + '">' + opts + '</select></td>' +
      '<td><code>' + esc(actual) + '</code></td>' +
      '<td style="font-size:.75rem;color:#94a3b8">' + esc(agent.target || (d && d.target) || '—') + '</td>' +
      '<td>' + (isDrift
        ? '<span class="badge badge-warn">drift</span>'
        : '<span class="badge" style="background:#14532d;color:#86efac">ok</span>') + '</td>' +
      '</tr>';
  });

  document.getElementById('assign-body').innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="6" class="empty">No discovered agents</td></tr>';

  document.getElementById('assign-body').querySelectorAll('select[data-agent]').forEach(function(sel) {
    sel.addEventListener('change', function() { onAssignChange(sel.dataset.agent, sel.value); });
  });

  var applyBar = document.getElementById('apply-bar');
  if (_pendingAssignments) {
    applyBar.style.display = 'flex';
    document.getElementById('apply-msg').textContent = 'Unsaved changes — click Apply to write to agent files and opencode.json.';
  } else {
    applyBar.style.display = drift.length ? 'flex' : 'none';
    if (drift.length) {
      document.getElementById('apply-msg').textContent = drift.length + ' agent(s) out of sync with registry.';
    }
  }
}

function onAssignChange(agentName, newModel) {
  if (!_pendingAssignments) {
    var regAssignments = (_registry && _registry.agent_assignments) || {};
    _pendingAssignments = {};
    _agents.forEach(function(agent) {
      _pendingAssignments[agent.name] = regAssignments[agent.name] || agent.model || '';
    });
  }
  _pendingAssignments[agentName] = newModel;
  renderAssignments();
}

function applyAssignments() {
  var reg = _registry || {};
  var regAssignments = reg.agent_assignments || {};
  var source = _pendingAssignments || {};
  var assignments = {};
  _agents.forEach(function(agent) {
    var val = Object.prototype.hasOwnProperty.call(source, agent.name)
      ? source[agent.name]
      : (regAssignments[agent.name] || agent.model || '');
    if (val && val !== '') assignments[agent.name] = val;
  });
  adminFetch('/api/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: assignments }),
  }).then(function() {
    loadAssignments();
    showToast('Assignments applied successfully', 'success');
  }).catch(function(e) {
    showToast('Apply failed: ' + e.message, 'error');
  });
}

function populateSel(id, options, current) {
  var sel = document.getElementById(id);
  var first = sel.options[0];
  sel.innerHTML = '';
  sel.appendChild(first);
  options.forEach(function(v) {
    var opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    if (v === current) opt.selected = true;
    sel.appendChild(opt);
  });
  if (!current) sel.value = '';
}

function appendStatsScopeParams(params) {
  params.set('time_range', _timeRange);
  var agentEl = document.getElementById('f-agent');
  var sessionEl = document.getElementById('f-session');
  var modelEl = document.getElementById('f-model');
  if (agentEl && agentEl.value) params.set('agent', agentEl.value);
  if (sessionEl && sessionEl.value) params.set('session_id', sessionEl.value);
  if (modelEl && modelEl.value) params.set('model_id', modelEl.value);
}

function clearExpandedDashboardRows() {
  _expandedRows = {};
  ['parent-sessions-body', 'agents-body'].forEach(function(id) {
    var tbody = document.getElementById(id);
    if (!tbody) return;
    tbody.querySelectorAll('tr[data-parent-key]').forEach(function(row) {
      if (row.parentNode) row.parentNode.removeChild(row);
    });
  });
}

function resetStatsViewState() {
  _parentPage = 1;
  _agentPage = 1;
  clearExpandedDashboardRows();
}

function activeSecondaryFilterCount() {
  var count = 0;
  if (document.getElementById('f-agent') && document.getElementById('f-agent').value) count++;
  if (document.getElementById('f-session') && document.getElementById('f-session').value) count++;
  if (document.getElementById('f-model') && document.getElementById('f-model').value) count++;
  return count;
}

function updateFilterBadge() {
  var badge = document.getElementById('filters-count');
  if (!badge) return;
  var count = activeSecondaryFilterCount();
  if (count > 0) {
    badge.textContent = String(count);
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function updateTimeRangeChips() {
  document.querySelectorAll('[data-time-range]').forEach(function(chip) {
    if (chip.dataset.timeRange === _timeRange) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

function setTimeRange(range) {
  _timeRange = range;
  updateTimeRangeChips();
  resetStatsViewState();
  loadStats();
}

function openStatsFilters() {
  document.getElementById('stats-filter-modal').classList.add('open');
}

function closeStatsFilters() {
  document.getElementById('stats-filter-modal').classList.remove('open');
}

function applyStatsFilters() {
  updateFilterBadge();
  closeStatsFilters();
  resetStatsViewState();
  loadStats();
}

function loadStats() {
  document.getElementById('parent-sessions-body').innerHTML = skeletonRows(4, 10);
  document.getElementById('agents-body').innerHTML = skeletonRows(3, 10);
  var params = new URLSearchParams();
  appendStatsScopeParams(params);
  var sortBy = document.getElementById('sort-by').value;
  var sortDir = document.getElementById('sort-dir').value;
  params.set('sort_by', sortBy);
  params.set('sort_dir', sortDir);
  params.set('parent_page', String(_parentPage));
  params.set('parent_page_size', String(_parentPageSize));
  params.set('agent_page', String(_agentPage));
  params.set('agent_page_size', String(_agentPageSize));

  apiFetch('/api/stats?' + params.toString()).then(function(data) {
    if (data.filters_applied && data.filters_applied.time_range) {
      _timeRange = data.filters_applied.time_range;
      updateTimeRangeChips();
    }
    if (data.filter_options) {
      var fa = data.filters_applied || {};
      populateSel('f-agent', data.filter_options.agents, fa.agent);
      populateSel('f-session', data.filter_options.session_ids, fa.session_id);
      populateSel('f-model', data.filter_options.model_ids, fa.model_id);
    }
    updateFilterBadge();
    document.getElementById('kpi-total').textContent = data.total_records != null ? data.total_records : '—';
    document.getElementById('kpi-dur').textContent = fmtDur(data.avg_duration_ms);
    document.getElementById('kpi-cost').textContent = fmt(data.total_cost_usd, 2);
    var summaryTokens = data.dashboard && data.dashboard.summary && data.dashboard.summary.total_tokens;
    document.getElementById('kpi-tokens').textContent = fmtTokens(
      summaryTokens != null ? summaryTokens : (data.tokens && data.tokens.total_tokens)
    );
    renderBars('top-agents', data.top_agents);
    renderBars('top-models', data.top_models);
    renderRecent(data.recent_records);
    renderParentSessions(data.dashboard && data.dashboard.parent_sessions);
    renderAgents(data.dashboard && data.dashboard.agents);
  }).catch(function(e) {
    document.getElementById('kpi-total').textContent = '—';
    document.getElementById('kpi-dur').textContent = '—';
    document.getElementById('kpi-cost').textContent = '—';
    document.getElementById('kpi-tokens').textContent = '—';
    document.getElementById('top-agents').innerHTML = '<div class="empty">—</div>';
    document.getElementById('top-models').innerHTML = '<div class="empty">—</div>';
    document.getElementById('recent-body').innerHTML = '<tr><td colspan="7" class="empty">—</td></tr>';
    document.getElementById('parent-sessions-body').innerHTML = '<tr><td colspan="10" class="empty">Error loading stats: ' + esc(e.message) + '</td></tr>';
    document.getElementById('agents-body').innerHTML = '<tr><td colspan="10" class="empty">—</td></tr>';
  });
}

function fmtUsd(v) {
  if (v == null || isNaN(+v)) return '—';
  return '$' + Number(v).toFixed(2);
}

function fmtBucket(row) {
  // Render fresh/cached/output token bucket values
  var fresh = row.fresh_input_tokens != null ? fmtTokens(row.fresh_input_tokens) : '—';
  var cached = row.cached_input_tokens != null ? fmtTokens(row.cached_input_tokens) : '—';
  var output = row.output_tokens != null ? fmtTokens(row.output_tokens) : '—';
  return { fresh: fresh, cached: cached, output: output };
}

function rowModelLabel(row) {
  var html = '<code>' + (row.model_id ? esc(row.model_id) : '\u2014') + '</code>';
  if (Array.isArray(row.sub_models) && row.sub_models.length > 0) {
    html += '<span class="sub-pill" title="' + esc(row.sub_models.join(', ')) + '">+' + row.sub_models.length + '</span>';
  }
  return html;
}

function agentHue(name) {
  var h = 0;
  for (var i = 0; i < name.length; i++) { h = ((h << 5) - h) + name.charCodeAt(i); h |= 0; }
  return Math.abs(h) % 360;
}
function rowAgentLabel(row) {
  if (!row.agent) return '—';
  var hue = agentHue(row.agent);
  var html = '<span class="agent-pill" style="background:hsl(' + hue + ',35%,14%);color:hsl(' + hue + ',65%,62%)">' + esc(row.agent) + '</span>';
  if (Array.isArray(row.sub_agents) && row.sub_agents.length > 0) {
    html += '<span class="sub-pill" title="' + esc(row.sub_agents.join(', ')) + '">+' + row.sub_agents.length + '</span>';
  }
  return html;
}

function hasCacheWriteUsage(rows) {
  return rows.some(function(row) {
    return (row.cache_write_tokens && row.cache_write_tokens !== 0) ||
           (row.cache_write_cost_usd && row.cache_write_cost_usd !== 0);
  });
}

function setCacheWriteColumnVisibility(tableKind, visible) {
  var bodyId = tableKind === 'parent' ? 'parent-sessions-body' : 'agents-body';
  var tableEl = document.getElementById(bodyId);
  if (!tableEl) return;
  var table = tableEl.closest('table');
  if (!table) return;
  table.querySelectorAll('.cache-write-col').forEach(function(el) {
    el.hidden = !visible;
  });
}

function renderDashboardRow(row, level, toggleKind) {
  var buckets = fmtBucket(row);
  var hasChildren = row.has_children === true && row.child_query != null;
  var rowKey = esc(row.row_key || ((row.row_type || 'row') + ':' + (row.id || row.label || row.session_id || row.agent || '')));
  var entityLabel = row.row_type === 'parent_session' && row.id
    ? esc(row.id.slice(0, 8) + '\u2026')
    : esc(truncateLabel(row.label || row.session_id || row.agent || null));
  var cacheWriteTokens = row.cache_write_tokens;
  var cacheWriteCostUsd = row.cache_write_cost_usd;
  var cacheWriteCell = (cacheWriteTokens != null ? fmtTokens(cacheWriteTokens) : '—') +
    (cacheWriteCostUsd != null ? ' / ' + fmtUsd(cacheWriteCostUsd) : '');
  var trAttrs = 'data-row-key="' + rowKey + '" data-toggle-kind="' + esc(toggleKind) + '" data-level="' + (level || 0) + '"';
  if (hasChildren) {
    trAttrs += ' data-child-query="' + esc(encodeURIComponent(JSON.stringify(row.child_query))) + '" style="cursor:pointer"';
  }
  if (row.record_id) {
    trAttrs += ' data-record-id="' + esc(row.record_id) + '"';
  }
  var agentCellContent = (toggleKind === 'agent' && row.row_type === 'agent_model') ? '—' : rowAgentLabel(row);
  var modelCellContent = (toggleKind === 'agent' && row.row_type === 'agent') ? '—' : rowModelLabel(row);
  return '<tr ' + trAttrs + '>' +
    '<td class="td-entity">' + (hasChildren ? '<span class="expand-icon">&#9654;</span>' : '<span class="expand-icon-ph"></span>') + entityLabel + '</td>' +
    '<td>' + agentCellContent + '</td>' +
    '<td class="td-model">' + modelCellContent + '</td>' +
    '<td class="td-runs">' + (row.run_count != null ? row.run_count : '—') + '</td>' +
    '<td class="td-tokens">' + buckets.fresh + '</td>' +
    '<td class="td-tokens">' + buckets.cached + '</td>' +
    '<td class="td-cache-write cache-write-col">' + cacheWriteCell + '</td>' +
    '<td class="td-tokens">' + buckets.output + '</td>' +
    '<td class="td-tokens">' + fmtTokens(row.total_tokens) + '</td>' +
    '<td class="td-cost">' + fmtUsd(row.total_cost_usd) + '</td>' +
    '</tr>';
}

function attachDashboardToggles(tbody) {
  tbody.querySelectorAll('tr[data-child-query]').forEach(function(row) {
    if (row.dataset.toggleAttached) return;
    row.dataset.toggleAttached = '1';
    row.addEventListener('click', function() {
      toggleDashboardRow(tbody, row);
    });
  });
}

function removeChildRows(tbody, parentKey) {
  var rows = tbody.querySelectorAll('tr[data-parent-key]');
  rows.forEach(function(row) {
    if (row.dataset.parentKey === parentKey) {
      var childKey = row.dataset.rowKey;
      if (childKey) {
        _expandedRows[childKey] = false;
        removeChildRows(tbody, childKey);
      }
      row.parentNode.removeChild(row);
    }
  });
}

function toggleDashboardRow(tbody, row) {
  var rowKey = row.dataset.rowKey;
  var kind = row.dataset.toggleKind;
  if (_expandedRows[rowKey]) {
    // Collapse
    _expandedRows[rowKey] = false;
    row.dataset.expanded = '';
    var colIcon = row.querySelector('.expand-icon');
    if (colIcon) colIcon.innerHTML = '&#9654;';
    removeChildRows(tbody, rowKey);
    return;
  }
  _expandedRows[rowKey] = true;
  row.dataset.expanded = '1';
  var expIcon = row.querySelector('.expand-icon');
  if (expIcon) expIcon.innerHTML = '&#9660;';
  var childQueryEnc = row.dataset.childQuery;
  var childQuery;
  try {
    childQuery = JSON.parse(decodeURIComponent(childQueryEnc));
  } catch(e) {
    _expandedRows[rowKey] = false;
    row.dataset.expanded = '';
    return;
  }
  var childParams = new URLSearchParams(childQuery);
  appendStatsScopeParams(childParams);
  apiFetch('/api/stats/children?' + childParams.toString()).then(function(data) {
    var rows = (data && data.rows) ? data.rows : [];
    var childLevel = parseInt(row.dataset.level || 0, 10) + 1;

    // Helper: insert a section sub-header then its rows, returning the last inserted element.
    function insertGroup(groupLabel, groupRows, insertAfter) {
      if (!groupRows.length) return insertAfter;
      var shHtml = '<tr class="section-subheader-row" data-parent-key="' + esc(rowKey) + '" data-level="' + childLevel + '">' +
        '<td colspan="12" class="section-subheader-cell">' + esc(groupLabel) + '</td>' +
        '</tr>';
      var tmpSh = document.createElement('tbody');
      tmpSh.innerHTML = shHtml;
      var shTr = tmpSh.firstChild;
      if (insertAfter && insertAfter.parentNode) {
        insertAfter.parentNode.insertBefore(shTr, insertAfter.nextSibling);
      } else {
        tbody.appendChild(shTr);
      }
      insertAfter = shTr;
      groupRows.forEach(function(childRow) {
        var childKind = childRow.child_query != null ? kind : '';
        var html = renderDashboardRow(childRow, childLevel, childKind);
        html = html.replace(/^<tr /, '<tr data-parent-key="' + esc(rowKey) + '" ');
        var tmp = document.createElement('tbody');
        tmp.innerHTML = html;
        var newTr = tmp.firstChild;
        if (insertAfter && insertAfter.parentNode) {
          insertAfter.parentNode.insertBefore(newTr, insertAfter.nextSibling);
        } else {
          tbody.appendChild(newTr);
        }
        insertAfter = newTr;
      });
      return insertAfter;
    }

    if (childQuery.kind === 'parent-session') {
      // Separate the parent's own messages from child sub-sessions.
      var msgRows = rows.filter(function(r) { return r.row_type === 'request'; });
      var subRows = rows.filter(function(r) { return r.row_type !== 'request'; });
      var cursor = row;
      cursor = insertGroup('Sub-sessions', subRows, cursor);
      insertGroup('Messages', msgRows, cursor);
    } else {
      var kindLabels = { 'agent-models': 'Models', 'agent-model-sessions': 'Sessions', 'session-requests': 'Requests' };
      var sectionLabel = kindLabels[childQuery.kind] || childQuery.kind || 'Children';
      insertGroup(sectionLabel, rows, row);
    }

    attachDashboardToggles(tbody);
    attachMessageRowClicks(tbody);
    // Re-sync cache-write visibility to cover newly inserted rows
    var tableEl = tbody.closest('table');
    var cwTh = tableEl && tableEl.querySelector('th.cache-write-col');
    var alreadyVisible = cwTh && !cwTh.hidden;
    setCacheWriteColumnVisibility(kind, alreadyVisible || hasCacheWriteUsage(rows));
  }).catch(function(e) {
    _expandedRows[rowKey] = false;
    row.dataset.expanded = '';
    var errRow = document.createElement('tr');
    errRow.setAttribute('data-parent-key', rowKey);
    errRow.innerHTML = '<td colspan="10" class="empty">Error loading children: ' + esc(e.message) + '</td>';
    if (row && row.parentNode) {
      row.parentNode.insertBefore(errRow, row.nextSibling);
    } else {
      tbody.appendChild(errRow);
    }
  });
}


function changeParentPage(delta) {
  var next = _parentPage + delta;
  if (next < 1 || next > _parentTotalPages) return;
  _parentPage = next;
  loadStats();
}

function changeAgentPage(delta) {
  var next = _agentPage + delta;
  if (next < 1 || next > _agentTotalPages) return;
  _agentPage = next;
  loadStats();
}

function renderParentSessions(payload) {
  var tbody = document.getElementById('parent-sessions-body');
  if (!payload) { tbody.innerHTML = '<tr><td colspan="10" class="empty">No data</td></tr>'; return; }
  var rows = Array.isArray(payload) ? payload : (payload.rows || []);
  if (payload.pagination) {
    _parentPage = payload.pagination.page || _parentPage;
    _parentTotalPages = payload.pagination.total_pages || 1;
  }
  document.getElementById('parent-page-info').textContent = 'Page ' + _parentPage + ' of ' + _parentTotalPages;
  document.getElementById('parent-prev').disabled = _parentPage <= 1;
  document.getElementById('parent-next').disabled = _parentPage >= _parentTotalPages;
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="10" class="empty">No parent sessions</td></tr>'; return; }
  tbody.innerHTML = rows.map(function(row) {
    return renderDashboardRow(row, 0, 'parent');
  }).join('');
  attachDashboardToggles(tbody);
  attachMessageRowClicks(tbody);
  setCacheWriteColumnVisibility('parent', hasCacheWriteUsage(rows));
}

function renderAgents(payload) {
  var tbody = document.getElementById('agents-body');
  if (!payload) { tbody.innerHTML = '<tr><td colspan="10" class="empty">No data</td></tr>'; return; }
  var rows = Array.isArray(payload) ? payload : (payload.rows || []);
  if (payload.pagination) {
    _agentPage = payload.pagination.page || _agentPage;
    _agentTotalPages = payload.pagination.total_pages || 1;
  }
  document.getElementById('agent-page-info').textContent = 'Page ' + _agentPage + ' of ' + _agentTotalPages;
  document.getElementById('agent-prev').disabled = _agentPage <= 1;
  document.getElementById('agent-next').disabled = _agentPage >= _agentTotalPages;
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="10" class="empty">No agents</td></tr>'; return; }
  tbody.innerHTML = rows.map(function(row) {
    return renderDashboardRow(row, 0, 'agent');
  }).join('');
  attachDashboardToggles(tbody);
  attachMessageRowClicks(tbody);
  setCacheWriteColumnVisibility('agent', hasCacheWriteUsage(rows));
}

function renderBars(id, items) {
  var el = document.getElementById(id);
  if (!items || !items.length) { el.innerHTML = '<div class="empty">No data</div>'; return; }
  var max = items[0].count;
  el.innerHTML = items.map(function(item) {
    return '<div class="bar-row">' +
      '<div class="bar-name" title="' + esc(item.name) + '">' + esc(item.name) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + Math.round(item.count/(max || 1)*100) + '%"></div></div>' +
      '<div class="bar-count">' + item.count + '</div>' +
      '</div>';
  }).join('');
}

function renderRecent(records) {
  var tbody = document.getElementById('recent-body');
  if (!records || !records.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No records yet</td></tr>'; return; }
  tbody.innerHTML = records.map(function(r) {
    return '<tr>' +
      '<td>' + esc(r.timestamp ? r.timestamp.replace('T',' ').replace('Z',' UTC') : '—') + '</td>' +
      '<td><span class="badge">' + esc(r.agent || '—') + '</span></td>' +
      '<td><code>' + esc(r.model_id || '—') + '</code></td>' +
      '<td>' + fmtDur(r.duration_ms) + '</td>' +
      '<td>' + fmt(r.effective_cost_usd != null ? r.effective_cost_usd : r.cost_usd, 2) + '</td>' +
      '<td>' + fmtTokens(r.total_tokens) + '</td>' +
      '<td class="' + scoreClass(r.composite) + '">' + fmt(r.composite, 2) + '</td>' +
      '</tr>';
  }).join('');
}

function resetFilters() {
  document.getElementById('f-agent').value = '';
  document.getElementById('f-session').value = '';
  document.getElementById('f-model').value = '';
  document.getElementById('sort-by').value = 'avg_composite';
  document.getElementById('sort-dir').value = 'desc';
  applyStatsFilters();
}

var _msgModalOpen = false;

function openMessageModal(recordId) {
  _msgModalOpen = true;
  document.getElementById('msg-detail-id').textContent = recordId;
  document.getElementById('msg-detail-meta').innerHTML = '';
  document.getElementById('msg-detail-body').innerHTML = '<div class="empty">Loading…</div>';
  document.getElementById('msg-detail-modal').classList.add('open');
  apiFetch('/api/stats/record?id=' + encodeURIComponent(recordId)).then(function(data) {
    renderMessageDetail(data.record);
  }).catch(function(e) {
    document.getElementById('msg-detail-body').innerHTML = '<div class="empty" style="color:#f87171">Error: ' + esc(e.message) + '</div>';
  });
}

function closeMessageModal() {
  _msgModalOpen = false;
  document.getElementById('msg-detail-modal').classList.remove('open');
}

function renderMessageDetail(rec) {
  if (!rec) {
    document.getElementById('msg-detail-body').innerHTML = '<div class="empty">Record not found</div>';
    return;
  }
  var ts = rec.timestamp ? rec.timestamp.replace('T', ' ').replace('Z', ' UTC') : '—';
  var metaItems = [
    { label: 'Timestamp', value: ts },
    { label: 'Agent', value: rec.agent || '—' },
    { label: 'Model', value: rec.model_id || '—' },
    { label: 'Duration', value: fmtDur(rec.duration_ms) },
    { label: 'Source', value: rec.source || '—' },
  ];
  if (rec.session_id) {
    metaItems.push({ label: 'Session', value: rec.session_id });
  }
  document.getElementById('msg-detail-meta').innerHTML = metaItems.map(function(m) {
    return '<div class="msg-meta-item"><div class="msg-meta-label">' + esc(m.label) + '</div>' +
      '<div class="msg-meta-value">' + esc(String(m.value)) + '</div></div>';
  }).join('');

  var tokens = rec.tokens || {};
  var freshInput = tokens.input != null ? tokens.input : null;
  var cachedInput = tokens.cache_read != null ? tokens.cache_read : null;
  var cacheWrite = tokens.cache_write != null ? tokens.cache_write : null;
  var output = tokens.output != null ? tokens.output : null;
  var effectiveInput = tokens.effective_input != null
    ? tokens.effective_input
    : ((freshInput || 0) + (cachedInput || 0) + (cacheWrite || 0));
  var costUsd = rec.cost_usd != null ? rec.cost_usd : null;

  var tokenCards = [
    { cls: 'fresh',       label: 'Input',   value: fmtTokens(freshInput)  },
    { cls: 'cached',      label: 'Cached',  value: fmtTokens(cachedInput) },
    { cls: 'cache-write', label: 'Cache write',   value: fmtTokens(cacheWrite)  },
    { cls: 'output',      label: 'Output',        value: fmtTokens(output)      },
    { cls: 'total',       label: 'Total tokens',  value: fmtTokens(effectiveInput + (output || 0)) },
    { cls: 'cost',        label: 'Total cost',    value: costUsd != null ? fmtUsd(costUsd) : '—' },
  ];
  var gridHtml = '<div class="msg-section-label">Tokens &amp; Cost</div>' +
    '<div class="msg-token-grid">' + tokenCards.map(function(c) {
      return '<div class="msg-token-card ' + c.cls + '">' +
        '<div class="msg-token-label">' + esc(c.label) + '</div>' +
        '<div class="msg-token-value">' + esc(c.value) + '</div>' +
        '</div>';
    }).join('') + '</div>';

  var scoresHtml = '';
  if (rec.scores && Object.keys(rec.scores).length) {
    scoresHtml = '<div class="msg-section-label">Scores</div>' +
      '<div class="msg-scores-row">' +
      Object.entries(rec.scores).map(function(e) {
        var v = e[1];
        var cls = v != null ? scoreClass(v) : '';
        return '<div class="msg-score-item">' +
          '<div class="msg-score-label">' + esc(e[0]) + '</div>' +
          '<div class="msg-score-value ' + cls + '">' + (v != null ? fmt(v, 4) : '—') + '</div>' +
          '</div>';
      }).join('') + '</div>';
  }

  var jsonHtml = '<button class="msg-json-toggle" id="msg-json-btn" onclick="toggleMsgJson()">▶ Raw record JSON</button>' +
    '<pre class="msg-json-pre" id="msg-json-pre">' + esc(JSON.stringify(rec, null, 2)) + '</pre>';

  document.getElementById('msg-detail-body').innerHTML = gridHtml + scoresHtml + jsonHtml;
}

function toggleMsgJson() {
  var pre = document.getElementById('msg-json-pre');
  var btn = document.getElementById('msg-json-btn');
  var open = pre.classList.toggle('open');
  btn.textContent = (open ? '▼' : '▶') + ' Raw record JSON';
}

function attachMessageRowClicks(tbody) {
  tbody.querySelectorAll('tr[data-row-key]').forEach(function(row) {
    if (row.dataset.messageClickAttached) return;
    var rowKey = row.dataset.rowKey || '';
    if (!rowKey.startsWith('request:')) return;
    row.dataset.messageClickAttached = '1';
    row.style.cursor = 'pointer';
    row.addEventListener('click', function() {
      openMessageModal(row.dataset.recordId || rowKey.replace(/^request:/, ''));
    });
  });
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && _msgModalOpen) closeMessageModal();
  if (e.key === 'Escape') _cancelConfirm();
});

// ── Utility: skeleton loading rows ──────────────────────────────────────────
function skeletonRows(n, cols) {
  var row = '<tr class="skeleton-row">' + Array(cols).fill('<td><span class="skeleton"></span></td>').join('') + '</tr>';
  return Array(n).fill(row).join('');
}

// ── Utility: toast notifications ─────────────────────────────────────────────
function showToast(msg, type) {
  var container = document.getElementById('toast-container');
  if (!container) return;
  var t = document.createElement('div');
  t.className = 'toast' + (type ? ' toast-' + type : '');
  var icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'i';
  t.innerHTML = '<em class="toast-icon">' + icon + '</em><span class="toast-msg">' + esc(msg) + '</span>';
  container.appendChild(t);
  setTimeout(function() {
    t.classList.add('toast-out');
    setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
  }, 3500);
}

// ── Utility: custom confirm modal ────────────────────────────────────────────
var _confirmCallback = null;
function confirmAction(msg, onConfirm) {
  _confirmCallback = onConfirm;
  document.getElementById('confirm-msg').textContent = msg;
  document.getElementById('confirm-modal').classList.add('open');
}
function _doConfirm() {
  document.getElementById('confirm-modal').classList.remove('open');
  if (_confirmCallback) { var cb = _confirmCallback; _confirmCallback = null; cb(); }
}
function _cancelConfirm() {
  document.getElementById('confirm-modal').classList.remove('open');
  _confirmCallback = null;
}

// ── Registry search ──────────────────────────────────────────────────────────
function filterRegistry() {
  var q = (document.getElementById('reg-search').value || '').toLowerCase();
  document.querySelectorAll('#reg-models-body tr').forEach(function(row) {
    if (row.classList.contains('skeleton-row')) return;
    row.style.display = (!q || row.textContent.toLowerCase().includes(q)) ? '' : 'none';
  });
}

showPage('stats');
`;
}

const HTML_SHELL_PREFIX = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Model Tracker</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 0;
    }
    nav {
      background: #1e2433; border-bottom: 1px solid #2d3748;
      padding: .75rem 1.5rem; display: flex; align-items: center; gap: 1.5rem;
      position: sticky; top: 0; z-index: 100;
    }
    nav h1 { font-size: 1rem; font-weight: 700; color: #f8fafc; flex: 1; }
    nav a {
      font-size: .82rem; color: #94a3b8; text-decoration: none; cursor: pointer;
      padding: .25rem .5rem; border-radius: 4px;
    }
    nav a:hover, nav a.active { color: #60a5fa; background: #172033; }
    .page { display: none; max-width: 1200px; margin: 0 auto; padding: 2rem 1.5rem; }
    .page.active { display: block; }
    .card { background: #1e2433; border: 1px solid #2d3748; border-radius: 10px; padding: 1.25rem 1.5rem; }
    .card-label { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; margin-bottom: .4rem; }
    .card-value { font-size: 1.1rem; font-weight: 600; color: #60a5fa; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; font-size: .82rem; margin-top: .75rem; }
    th { background: #1e2433; color: #94a3b8; padding: .6rem .75rem; text-align: left; font-weight: 600; border-bottom: 1px solid #2d3748; white-space: nowrap; }
    td { padding: .55rem .75rem; border-bottom: 1px solid #1e2433; color: #cbd5e1; }
    tr:hover td { background: #1a2030; }
    tr.drift td { background: #2d1f0a; }
    .empty { color: #64748b; font-style: italic; padding: 1.5rem 0; text-align: center; }
    .badge { display: inline-block; padding: .15rem .45rem; border-radius: 4px; font-size: .75rem; font-weight: 600; background: #1e3a5f; color: #93c5fd; }
    .badge-dim { background: #2d3748; color: #94a3b8; }
    .badge-warn { background: #451a03; color: #fb923c; }
    code { font-family: monospace; font-size: .78rem; }
    .btn { border-radius: 6px; padding: .38rem .85rem; font-size: .8rem; cursor: pointer; border: 1px solid; }
    .btn-primary { background: #1e3a5f; border-color: #2563eb; color: #93c5fd; }
    .btn-primary:hover { background: #1e4080; }
    .btn-danger { background: #450a0a; border-color: #991b1b; color: #fca5a5; }
    .btn-ghost { background: transparent; border-color: #2d3748; color: #94a3b8; }
    .btn-ghost:hover { background: #1e2433; color: #e2e8f0; }
    .apply-bar {
      position: sticky; bottom: 0; background: #1e2433; border-top: 1px solid #2d3748;
      padding: .75rem 1.5rem; display: flex; align-items: center; gap: 1rem; z-index: 50;
    }
    .apply-bar span { font-size: .82rem; color: #94a3b8; flex: 1; }
    .filter-group { display: flex; flex-direction: column; gap: .3rem; }
    .filter-group label { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; }
    .filter-group select { background: #0f1117; border: 1px solid #2d3748; color: #e2e8f0; border-radius: 6px; padding: .35rem .6rem; font-size: .82rem; min-width: 160px; }
    .stats-toolbar { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
    .stats-time-range { display: inline-flex; gap: .2rem; background: #1e2433; border: 1px solid #2d3748; border-radius: 9px; padding: .2rem; }
    .time-chip { background: transparent; border: 0; color: #94a3b8; border-radius: 7px; padding: .4rem .6rem; font-size: .8rem; cursor: pointer; }
    .time-chip:hover { background: #172033; color: #cbd5e1; }
    .time-chip.active { background: #1e3a5f; color: #bfdbfe; }
    .filter-count { align-items: center; justify-content: center; min-width: 1.1rem; height: 1.1rem; margin-left: .35rem; border-radius: 999px; background: #2563eb; color: #eff6ff; font-size: .68rem; font-weight: 700; }
    .filter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .8rem; }
    .stats-filter-modal { width: min(720px, 95vw); }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .kpi-value { font-size: 2rem; font-weight: 700; color: #60a5fa; }
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 2rem; }
    @media (max-width: 700px) { .panels { grid-template-columns: 1fr; } }
    .bar-list { display: flex; flex-direction: column; gap: .5rem; }
    .bar-row { display: flex; align-items: center; gap: .75rem; font-size: .85rem; }
    .bar-name { width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #e2e8f0; }
    .bar-track { flex: 1; background: #2d3748; border-radius: 4px; height: 10px; }
    .bar-fill { height: 10px; border-radius: 4px; background: #3b82f6; }
    .bar-count { width: 40px; text-align: right; color: #94a3b8; }
    .score-high { color: #4ade80; } .score-mid { color: #fbbf24; } .score-low { color: #f87171; }
    h2 { font-size: 1rem; font-weight: 600; color: #cbd5e1; margin-bottom: .75rem; }
    section { margin-bottom: 2rem; }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 200; display: none; align-items: center; justify-content: center; }
    .modal-backdrop.open { display: flex; }
    .modal { background: #1e2433; border: 1px solid #2d3748; border-radius: 12px; padding: 1.5rem; width: min(600px, 95vw); max-height: 80vh; overflow-y: auto; }
    .modal h3 { font-size: .95rem; font-weight: 600; color: #f8fafc; margin-bottom: 1rem; }
    textarea { width: 100%; background: #0f1117; border: 1px solid #2d3748; color: #e2e8f0; border-radius: 6px; padding: .5rem .75rem; font-family: monospace; font-size: .78rem; resize: vertical; min-height: 200px; }
    .modal-actions { display: flex; gap: .75rem; margin-top: 1rem; justify-content: flex-end; }
    .error-msg { color: #f87171; font-size: .8rem; margin-top: .5rem; }
    select.assignment-sel { background: #0f1117; border: 1px solid #2d3748; color: #e2e8f0; border-radius: 6px; padding: .25rem .5rem; font-size: .78rem; }
    /* Sessions / Agents table card redesign */
    .sessions-section { border: 1px solid #1f2937; border-radius: 12px; overflow: hidden; background: #111827; }
    .sessions-header { padding: .875rem 1.25rem; display: flex; align-items: center; gap: .75rem; border-bottom: 1px solid #1f2937; background: #161d2b; }
    .sessions-title { font-size: .66rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .1em; }
    .sessions-pagination { margin-left: auto; display: flex; align-items: center; gap: .35rem; }
    .sessions-page-btn { background: transparent; border: 1px solid #1f2937; color: #374151; border-radius: 5px; padding: .15rem .55rem; font-size: .8rem; cursor: pointer; transition: background .12s, border-color .12s, color .12s; line-height: 1.6; }
    .sessions-page-btn:hover:not(:disabled) { border-color: #374151; color: #94a3b8; background: #1f2937; }
    .sessions-page-btn:disabled { opacity: .28; cursor: default; }
    .sessions-page-info { font-size: .68rem; color: #374151; padding: 0 .3rem; }
    .sessions-table-wrap { overflow-x: auto; }
    .sessions-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .sessions-table thead th { background: #0d1117; padding: .55rem .875rem; text-align: left; font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; border-bottom: 1px solid #1f2937; white-space: nowrap; color: #374151; }
    .sessions-table thead th.th-tokens { color: #164e63; }
    .sessions-table thead th.th-cost { color: #78350f; }
    .sessions-table tbody td { padding: .525rem .875rem; border-bottom: 1px solid #0d1117; color: #6b7280; vertical-align: middle; transition: background .08s; }
    .sessions-table tbody tr:last-child td { border-bottom: none; }
    .sessions-table tbody tr:hover td { background: #131c2e; }
    .sessions-table .td-entity { color: #cbd5e1; font-weight: 500; font-size: .82rem; white-space: nowrap; }
    .sessions-table .td-runs { color: #9ca3af; font-variant-numeric: tabular-nums; font-weight: 600; }
    .sessions-table .td-tokens { color: #0e7490; font-family: "SF Mono", ui-monospace, monospace; font-size: .76rem; }
    .sessions-table .td-cost { color: #b45309; font-family: "SF Mono", ui-monospace, monospace; font-size: .76rem; }
    .sessions-table .td-cache-write { color: #6d28d9; font-family: "SF Mono", ui-monospace, monospace; font-size: .76rem; }
    .sessions-table .td-model code { font-family: "SF Mono", ui-monospace, monospace; font-size: .72rem; color: #38bdf8; background: #082032; padding: .1rem .35rem; border-radius: 3px; }
    .sessions-table .toggle-icon { display: none; }
    /* Tree grouping: left-rail bracket, no icons */
    .sessions-table tr[data-level="1"] td:first-child { box-shadow: inset 2px 0 0 rgba(59,130,246,.28); }
    .sessions-table tr[data-level="1"] .td-entity { padding-left: .9rem; color: #94a3b8; font-size: .8rem; font-weight: 400; }
    .sessions-table tr[data-level="2"] td:first-child { box-shadow: inset 2px 0 0 rgba(139,92,246,.24); }
    .sessions-table tr[data-level="2"] .td-entity { padding-left: 1.625rem; color: #6b7280; font-size: .78rem; }
    .sessions-table tr[data-level="3"] td:first-child { box-shadow: inset 2px 0 0 rgba(20,184,166,.2); }
    .sessions-table tr[data-level="3"] .td-entity { padding-left: 2.35rem; color: #4b5563; font-size: .76rem; }
    /* Section sub-header rows (inserted when expanding tree rows) */
    .section-subheader-row td { background: #080c12; color: #374151; font-size: .65rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; padding: .3rem .875rem; border-bottom: 1px solid #0d1117; }
    .section-subheader-row:hover td { background: #080c12 !important; }
    .sessions-table tr[data-level="1"].section-subheader-row td { padding-left: 1.5rem; box-shadow: inset 2px 0 0 rgba(59,130,246,.28); }
    .sessions-table tr[data-level="2"].section-subheader-row td { padding-left: 2.4rem; box-shadow: inset 2px 0 0 rgba(139,92,246,.24); }
    .sessions-table tr[data-level="3"].section-subheader-row td { padding-left: 3.2rem; box-shadow: inset 2px 0 0 rgba(20,184,166,.2); }
    .sessions-table tr[data-level="4"].section-subheader-row td { padding-left: 4rem; }
    .agent-pill { display: inline-flex; align-items: center; padding: .1rem .45rem; border-radius: 100px; font-size: .68rem; font-weight: 700; letter-spacing: .02em; }
    .sub-pill { display: inline-flex; align-items: center; padding: .1rem .4rem; border-radius: 100px; font-size: .65rem; font-weight: 600; background: #1f2937; color: #4b5563; margin-left: .25rem; }
    /* Message detail modal */
    .msg-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.78); z-index: 300; display: none; align-items: center; justify-content: center; padding: 1rem; }
    .msg-modal-backdrop.open { display: flex; }
    .msg-modal { background: #0d1117; border: 1px solid #21262d; border-radius: 16px; width: min(820px, 100%); max-height: 90vh; overflow-y: auto; box-shadow: 0 32px 80px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.05); }
    .msg-modal-header { padding: 1.25rem 1.5rem; border-bottom: 1px solid #161d2b; display: flex; align-items: flex-start; gap: 1rem; background: #0a0e14; border-radius: 16px 16px 0 0; }
    .msg-modal-eyebrow { font-size: .6rem; text-transform: uppercase; letter-spacing: .1em; color: #374151; margin-bottom: .3rem; }
    .msg-modal-id { font-family: "SF Mono", ui-monospace, monospace; font-size: .72rem; color: #4b5563; word-break: break-all; flex: 1; line-height: 1.7; }
    .msg-modal-close { flex-shrink: 0; background: transparent; border: 1px solid #21262d; border-radius: 6px; color: #4b5563; cursor: pointer; padding: .25rem .6rem; font-size: .85rem; line-height: 1.5; transition: background .1s, color .1s; }
    .msg-modal-close:hover { background: #161d2b; color: #94a3b8; }
    .msg-modal-meta { padding: .875rem 1.5rem; border-bottom: 1px solid #161d2b; display: flex; gap: 1.75rem; flex-wrap: wrap; background: #0a0e14; }
    .msg-meta-item { display: flex; flex-direction: column; gap: .2rem; }
    .msg-meta-label { font-size: .6rem; text-transform: uppercase; letter-spacing: .08em; color: #374151; }
    .msg-meta-value { font-size: .82rem; color: #94a3b8; font-family: "SF Mono", ui-monospace, monospace; }
    .msg-modal-body { padding: 1.25rem 1.5rem; }
    .msg-section-label { font-size: .62rem; text-transform: uppercase; letter-spacing: .09em; color: #374151; margin-bottom: .6rem; }
    .msg-token-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .625rem; margin-bottom: 1.25rem; }
    @media (max-width: 520px) { .msg-token-grid { grid-template-columns: 1fr 1fr; } }
    .msg-token-card { border-radius: 10px; padding: .875rem 1rem; }
    .msg-token-card.fresh      { background: #061528; border: 1px solid #0f2545; }
    .msg-token-card.cached     { background: #041820; border: 1px solid #0a3040; }
    .msg-token-card.cache-write{ background: #12082a; border: 1px solid #241050; }
    .msg-token-card.output     { background: #041c14; border: 1px solid #083826; }
    .msg-token-card.total      { background: #0d1117; border: 1px solid #1a2233; }
    .msg-token-card.cost       { background: #1a100a; border: 1px solid #3a200a; }
    .msg-token-label { font-size: .6rem; text-transform: uppercase; letter-spacing: .08em; margin-bottom: .4rem; }
    .msg-token-card.fresh       .msg-token-label { color: #1d4ed8; }
    .msg-token-card.cached      .msg-token-label { color: #0e7490; }
    .msg-token-card.cache-write .msg-token-label { color: #6d28d9; }
    .msg-token-card.output      .msg-token-label { color: #065f46; }
    .msg-token-card.total       .msg-token-label { color: #374151; }
    .msg-token-card.cost        .msg-token-label { color: #92400e; }
    .msg-token-value { font-family: "SF Mono", ui-monospace, monospace; font-size: 1.05rem; font-weight: 700; }
    .msg-token-card.fresh       .msg-token-value { color: #3b82f6; }
    .msg-token-card.cached      .msg-token-value { color: #22d3ee; }
    .msg-token-card.cache-write .msg-token-value { color: #a78bfa; }
    .msg-token-card.output      .msg-token-value { color: #34d399; }
    .msg-token-card.total       .msg-token-value { color: #64748b; }
    .msg-token-card.cost        .msg-token-value { color: #f59e0b; }
    .msg-scores-row { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
    .msg-score-item { display: flex; flex-direction: column; gap: .2rem; }
    .msg-score-label { font-size: .6rem; text-transform: uppercase; letter-spacing: .07em; color: #374151; }
    .msg-score-value { font-family: "SF Mono", ui-monospace, monospace; font-size: .95rem; font-weight: 600; }
    .msg-json-toggle { background: #0a0e14; border: 1px solid #21262d; border-radius: 7px; color: #4b5563; cursor: pointer; padding: .4rem .875rem; font-size: .75rem; display: flex; align-items: center; gap: .4rem; width: 100%; text-align: left; margin-top: .25rem; transition: background .1s, color .1s; }
    .msg-json-toggle:hover { background: #161d2b; color: #6b7280; }
    .msg-json-pre { background: #070b10; border: 1px solid #161d2b; border-radius: 8px; padding: 1rem; font-family: "SF Mono", ui-monospace, monospace; font-size: .7rem; color: #4b5563; overflow-x: auto; white-space: pre; max-height: 320px; overflow-y: auto; margin-top: .5rem; display: none; }
    .msg-json-pre.open { display: block; }
    /* Toast notifications */
    .toast-container { position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999; display: flex; flex-direction: column; gap: .5rem; pointer-events: none; }
    .toast { background: #1e2433; border: 1px solid #2d3748; border-radius: 8px; padding: .7rem 1rem; font-size: .82rem; color: #e2e8f0; box-shadow: 0 4px 20px rgba(0,0,0,.55); display: flex; align-items: center; gap: .65rem; min-width: 260px; max-width: 380px; pointer-events: all; animation: toast-in .18s ease; transition: opacity .3s, transform .3s; }
    .toast.toast-out { opacity: 0; transform: translateY(6px); }
    .toast.toast-success { border-color: #166534; background: #052e16; }
    .toast.toast-error { border-color: #991b1b; background: #450a0a; }
    .toast-icon { font-size: .95rem; flex-shrink: 0; font-style: normal; }
    .toast.toast-success .toast-icon { color: #4ade80; }
    .toast.toast-error .toast-icon { color: #f87171; }
    .toast-msg { flex: 1; }
    @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    /* Expand indicator in tree rows */
    .expand-icon { display: inline-block; font-size: .65rem; color: #4b5563; margin-right: .4rem; width: .85rem; text-align: center; transition: color .1s; }
    .expand-icon-ph { display: inline-block; width: 1.25rem; }
    .sessions-table tr[data-child-query] .td-entity { cursor: pointer; }
    .sessions-table tr[data-child-query]:hover .expand-icon { color: #94a3b8; }
    /* Skeleton loading */
    .skeleton { display: inline-block; background: linear-gradient(90deg, #1e2433 25%, #263040 50%, #1e2433 75%); background-size: 200% 100%; animation: skeleton-pulse 1.4s ease infinite; border-radius: 4px; height: 12px; width: 70%; }
    .skeleton-row td { padding: .6rem .75rem; border-bottom: 1px solid #1e2433; }
    .skeleton-row td:first-child .skeleton { width: 50%; }
    .skeleton-row td:last-child .skeleton { width: 40%; }
    @keyframes skeleton-pulse { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    /* Button loading/disabled */
    .btn:disabled { opacity: .55; cursor: default; }
    /* Registry search input */
    .reg-search { background: #0f1117; border: 1px solid #2d3748; color: #e2e8f0; border-radius: 6px; padding: .35rem .65rem; font-size: .82rem; min-width: 210px; outline: none; }
    .reg-search:focus { border-color: #3b82f6; }
    .reg-search::placeholder { color: #4b5563; }
    /* Nav active indicator */
    nav a.active { color: #60a5fa; background: #172033; box-shadow: inset 0 -2px 0 #3b82f6; }
  </style>
</head>
<body>

<nav>
  <h1>Model Tracker</h1>
  <a onclick="showPage('registry')" id="nav-registry">Registry</a>
  <a onclick="showPage('assignments')" id="nav-assignments">Assignments</a>
  <a onclick="showPage('stats')" id="nav-stats">Stats</a>
</nav>

<div class="page" id="page-registry">
  <section>
    <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem;flex-wrap:wrap">
      <h2 style="margin:0">Models</h2>
      <button class="btn btn-primary" onclick="openAddModel()">+ Add Model</button>
      <input type="search" id="reg-search" class="reg-search" placeholder="Search models…" oninput="filterRegistry()" style="margin-left:auto">
    </div>
    <table>
      <thead><tr><th>ID</th><th>Name</th><th>Provider</th><th>Context</th><th>Cost In</th><th>Cost Out</th><th>Notes</th><th></th></tr></thead>
      <tbody id="reg-models-body"></tbody>
    </table>
  </section>
</div>

<div class="page" id="page-assignments">
  <section>
    <h2>Agent Assignments</h2>
    <p style="font-size:.8rem;color:#94a3b8;margin-bottom:1rem">Drift rows are highlighted. Click Apply to sync changes to agent files and opencode.json.</p>
    <div id="sync-status-msg" style="font-size:.82rem;margin-bottom:.75rem;color:#94a3b8"></div>
    <table>
      <thead><tr><th>Agent</th><th>Source</th><th>Registry Model</th><th>File Model</th><th>Target</th><th>Status</th></tr></thead>
      <tbody id="assign-body"></tbody>
    </table>
  </section>
  <div class="apply-bar" id="apply-bar" style="display:none">
    <span id="apply-msg"></span>
    <button class="btn btn-primary" onclick="applyAssignments()">Apply Changes</button>
  </div>
</div>

<div class="page" id="page-stats">
  <div class="stats-toolbar">
    <div class="stats-time-range" id="stats-time-range" aria-label="Stats time range">
      <button class="time-chip" data-time-range="15m" onclick="setTimeRange('15m')">15m</button>
      <button class="time-chip" data-time-range="30m" onclick="setTimeRange('30m')">30m</button>
      <button class="time-chip active" data-time-range="1h" onclick="setTimeRange('1h')">1h</button>
      <button class="time-chip" data-time-range="24h" onclick="setTimeRange('24h')">24h</button>
      <button class="time-chip" data-time-range="7d" onclick="setTimeRange('7d')">7d</button>
      <button class="time-chip" data-time-range="30d" onclick="setTimeRange('30d')">30d</button>
      <button class="time-chip" data-time-range="all" onclick="setTimeRange('all')">All</button>
    </div>
    <button class="btn btn-primary" id="open-filters" onclick="openStatsFilters()">Filters <span class="filter-count" id="filters-count" style="display:none">0</span></button>
  </div>

  <div class="modal-backdrop" id="stats-filter-modal" onclick="if(event.target===this)closeStatsFilters()">
    <div class="modal stats-filter-modal" role="dialog" aria-modal="true" aria-labelledby="stats-filter-title">
      <h3 id="stats-filter-title">Filters</h3>
      <div class="filter-grid">
        <div class="filter-group"><label>Agent</label><select id="f-agent"><option value="">All agents</option></select></div>
        <div class="filter-group"><label>Session</label><select id="f-session"><option value="">All sessions</option></select></div>
        <div class="filter-group"><label>Model</label><select id="f-model"><option value="">All models</option></select></div>
        <div class="filter-group"><label>Sort by</label>
          <select id="sort-by">
            <option value="avg_composite">Avg Composite</option>
            <option value="avg_effective_quality">Avg Quality</option>
            <option value="avg_duration_ms">Avg Duration</option>
            <option value="total_cost_usd">Total Cost</option>
            <option value="runs">Runs</option>
          </select>
        </div>
        <div class="filter-group"><label>Direction</label>
          <select id="sort-dir"><option value="desc">Desc</option><option value="asc">Asc</option></select>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="resetFilters()">Reset</button>
        <button class="btn btn-ghost" onclick="closeStatsFilters()">Cancel</button>
        <button class="btn btn-primary" onclick="applyStatsFilters()">Apply filters</button>
      </div>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="card"><div class="card-label">Total Records</div><div class="kpi-value" id="kpi-total">—</div></div>
    <div class="card"><div class="card-label">Avg Duration</div><div class="kpi-value" id="kpi-dur">—</div></div>
    <div class="card"><div class="card-label">Total Cost</div><div class="kpi-value" id="kpi-cost">—</div></div>
    <div class="card"><div class="card-label">Total Tokens</div><div class="kpi-value" id="kpi-tokens">—</div></div>
  </div>

  <div class="panels">
    <section><h2>Top Agents</h2><div class="bar-list" id="top-agents"></div></section>
    <section><h2>Top Models</h2><div class="bar-list" id="top-models"></div></section>
  </div>

  <section class="sessions-section">
    <div class="sessions-header">
      <span class="sessions-title">Parent Sessions</span>
      <div class="sessions-pagination">
        <button class="sessions-page-btn" id="parent-prev" onclick="changeParentPage(-1)" disabled="">&#8249;</button>
        <span class="sessions-page-info" id="parent-page-info">Page 1 of 1</span>
        <button class="sessions-page-btn" id="parent-next" onclick="changeParentPage(1)" disabled="">&#8250;</button>
      </div>
    </div>
    <div class="sessions-table-wrap">
      <table class="sessions-table">
        <thead><tr>
          <th>Entity</th><th>Agent</th><th>Model</th><th>Runs</th>
          <th class="th-tokens">Fresh input</th><th class="th-tokens">Cached input</th>
          <th class="th-cost cache-write-col">Cache write</th>
          <th class="th-tokens">Output</th><th class="th-tokens">Total tokens</th>
          <th class="th-cost">Total cost</th>
        </tr></thead>
        <tbody id="parent-sessions-body"></tbody>
      </table>
    </div>
  </section>

  <section class="sessions-section">
    <div class="sessions-header">
      <span class="sessions-title">Agents</span>
      <div class="sessions-pagination">
        <button class="sessions-page-btn" id="agent-prev" onclick="changeAgentPage(-1)" disabled="">&#8249;</button>
        <span class="sessions-page-info" id="agent-page-info">Page 1 of 1</span>
        <button class="sessions-page-btn" id="agent-next" onclick="changeAgentPage(1)" disabled="">&#8250;</button>
      </div>
    </div>
    <div class="sessions-table-wrap">
      <table class="sessions-table">
        <thead><tr>
          <th>Entity</th><th>Agent</th><th>Model</th><th>Runs</th>
          <th class="th-tokens">Fresh input</th><th class="th-tokens">Cached input</th>
          <th class="th-cost cache-write-col">Cache write</th>
          <th class="th-tokens">Output</th><th class="th-tokens">Total tokens</th>
          <th class="th-cost">Total cost</th>
        </tr></thead>
        <tbody id="agents-body"></tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Recent Records</h2>
    <table>
      <thead><tr><th>Timestamp</th><th>Agent</th><th>Model</th><th>Duration</th><th>Cost</th><th>Tokens</th><th>Composite</th></tr></thead>
      <tbody id="recent-body"></tbody>
    </table>
  </section>
</div>

<div class="toast-container" id="toast-container"></div>

<div class="modal-backdrop" id="confirm-modal">
  <div class="modal" style="max-width:400px">
    <h3 style="margin-bottom:.75rem">Confirm action</h3>
    <p id="confirm-msg" style="font-size:.85rem;color:#94a3b8;margin-bottom:1.25rem;line-height:1.5"></p>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="_cancelConfirm()">Cancel</button>
      <button class="btn btn-danger" onclick="_doConfirm()">Confirm</button>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="model-modal">
  <div class="modal">
    <h3 id="modal-title">Edit Model</h3>
    <div class="filter-group" id="modal-id-group" style="display:none;margin-bottom:.75rem">
      <label style="font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;display:block;margin-bottom:.3rem">Model ID</label>
      <input type="text" id="modal-new-id" placeholder="e.g. openai/gpt-5" style="width:100%;background:#0f1117;border:1px solid #2d3748;color:#e2e8f0;border-radius:6px;padding:.38rem .65rem;font-size:.82rem;font-family:monospace;outline:none" onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#2d3748'">
    </div>
    <textarea id="modal-json" rows="12" spellcheck="false"></textarea>
    <div class="error-msg" id="modal-error"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" id="modal-delete-btn" onclick="deleteModel()" style="display:none">Delete</button>
      <button class="btn btn-primary" id="modal-save-btn" onclick="saveModel()">Save</button>
    </div>
  </div>
</div>

<div class="msg-modal-backdrop" id="msg-detail-modal" onclick="if(event.target===this)closeMessageModal()">
  <div class="msg-modal" role="dialog" aria-modal="true" aria-labelledby="msg-detail-eyebrow">
    <div class="msg-modal-header">
      <div style="flex:1;min-width:0">
        <div class="msg-modal-eyebrow" id="msg-detail-eyebrow">Message Detail</div>
        <div class="msg-modal-id" id="msg-detail-id">—</div>
      </div>
      <button class="msg-modal-close" onclick="closeMessageModal()" aria-label="Close">✕</button>
    </div>
    <div class="msg-modal-meta" id="msg-detail-meta"></div>
    <div class="msg-modal-body" id="msg-detail-body">
      <div class="empty">Loading…</div>
    </div>
  </div>
</div>

<script>
`;

const HTML_SHELL_SUFFIX = `</script>
</body>
</html>`;

/**
 * Generate the admin UI HTML with the given admin token embedded in the inline
 * script. The token is only accessible to same-origin JavaScript — it is never
 * exposed via a JSON API endpoint and is not logged.
 *
 * @param {string} token - Hex admin token (must not contain single quotes or
 *   other characters that would break the JS string literal; crypto-random hex
 *   tokens satisfy this constraint).
 * @returns {string} Complete HTML document.
 */
export function generateUI(token) {
  if (token !== "" && !/^[0-9a-f]+$/.test(token)) {
    throw new TypeError(
      `generateUI: token must be a lowercase hex string or empty string, got: ${JSON.stringify(token)}`
    );
  }
  return HTML_SHELL_PREFIX + buildScript(token) + HTML_SHELL_SUFFIX;
}

// Static export for backward compatibility and tests that only inspect HTML structure.
// Uses an empty token — mutating calls from this HTML will fail auth, which is safe.
export const UI_HTML = generateUI("");
