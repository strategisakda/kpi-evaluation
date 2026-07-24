// แอปหลัก — ย้ายจาก Apps Script (google.script.run) มาเป็น REST API (fetch) + httpOnly session cookie
// ไม่ต้องเก็บ TOKEN เอง (เดิมเก็บใน localStorage) — cookie แนบไปกับทุก request อัตโนมัติ
var BOOT = null;
var CURRENT_USER = null;
var CALC_ENABLED = ['T1', 'T2', 'T3', 'P1', 'P3', 'P10'];
var currentCalcDistrict = null;
var currentCalcSuggestedScore = null;
var currentReviewKpiId = null;
var currentReviewRequiresEvidence = true;
var kpiSettingsReviewers = [];
var dashboardChartInstance = null;
var kpiRadarChartInstance = null;
var PROVINCE_DASHBOARD_DATA = [];
var LAST_DISTRICT_KPI_ROWS = [];
var LAST_REVIEW_ROWS = [];
var LAST_MY_SUBMISSION_ROWS = [];

// ---------- ตัวช่วยเรียก API ----------

async function apiFetch(path, options) {
  const opts = Object.assign({ credentials: 'same-origin' }, options || {});
  const res = await fetch(path, opts);
  let body;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok || !body || body.ok === false) {
    const err = new Error((body && body.error) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return body;
}

function apiGet(path) { return apiFetch(path); }
function apiPost(path, data) {
  return apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
}
function apiDelete(path, data) {
  return apiFetch(path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
}

// ---------- Auth ----------

function showLoginScreen(message) {
  document.getElementById('appShell').classList.add('d-none');
  document.getElementById('loginScreen').classList.remove('d-none');
  var errBox = document.getElementById('loginErrorBox');
  if (message) { document.getElementById('loginErrorText').textContent = message; errBox.classList.remove('d-none'); }
  else { errBox.classList.add('d-none'); }
}

async function handleLoginSubmit() {
  var username = document.getElementById('loginUsername').value.trim();
  var password = document.getElementById('loginPassword').value;
  if (!username || !password) { showLoginScreen('กรุณากรอกชื่อผู้ใช้งานและรหัสผ่าน'); return; }
  showLoading(true);
  try {
    const result = await apiPost('/api/auth/login', { username, password });
    CURRENT_USER = result.user;
    showLoading(false);
    enterApp();
  } catch (err) {
    showLoading(false);
    showLoginScreen(err.message);
  }
}

async function handleLogout() {
  CURRENT_USER = null;
  PROVINCE_DASHBOARD_DATA = [];
  document.getElementById('kpiChatFab').classList.add('d-none');
  hideDistrictFilter();
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  showLoginScreen();
  try { await apiPost('/api/auth/logout'); } catch (e) { /* ไม่ต้องแจ้ง error */ }
}

function openChangePasswordModal() {
  document.getElementById('cpCurrentPassword').value = '';
  document.getElementById('cpNewPassword').value = '';
  document.getElementById('cpConfirmPassword').value = '';
  document.getElementById('changePasswordError').classList.add('d-none');
  new bootstrap.Modal(document.getElementById('changePasswordModal')).show();
}

async function submitChangePassword() {
  var current = document.getElementById('cpCurrentPassword').value;
  var next = document.getElementById('cpNewPassword').value;
  var confirmPw = document.getElementById('cpConfirmPassword').value;
  var errBox = document.getElementById('changePasswordError');
  errBox.classList.add('d-none');

  if (!current || !next || !confirmPw) { errBox.textContent = 'กรุณากรอกให้ครบทุกช่อง'; errBox.classList.remove('d-none'); return; }
  if (next.length < 6) { errBox.textContent = 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร'; errBox.classList.remove('d-none'); return; }
  if (next !== confirmPw) { errBox.textContent = 'รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน'; errBox.classList.remove('d-none'); return; }

  showLoading(true);
  try {
    await apiPost('/api/auth/change-password', { currentPassword: current, newPassword: next });
    showLoading(false);
    bootstrap.Modal.getInstance(document.getElementById('changePasswordModal')).hide();
    showToast('เปลี่ยนรหัสผ่านสำเร็จ ใช้รหัสใหม่ในการล็อกอินครั้งต่อไป', 'success');
  } catch (err) {
    showLoading(false);
    errBox.textContent = err.message;
    errBox.classList.remove('d-none');
  }
}

async function enterApp() {
  document.getElementById('loginScreen').classList.add('d-none');
  document.getElementById('appShell').classList.remove('d-none');
  document.getElementById('kpiChatFab').classList.remove('d-none');

  var initial = (CURRENT_USER.displayName || CURRENT_USER.username).charAt(0).toUpperCase();
  document.getElementById('navAvatarInitial').textContent = initial;
  document.getElementById('navUsernameLabel').textContent = CURRENT_USER.displayName || CURRENT_USER.username;
  var roleLabel = CURRENT_USER.role === 'SuperAdmin' ? 'ผู้ดูแลระบบ' : (CURRENT_USER.role === 'Admin' ? 'นักวิชาการ' : ('อำเภอ' + CURRENT_USER.district));
  var pill = document.getElementById('navRolePill');
  pill.textContent = roleLabel;
  pill.className = 'role-pill d-none d-sm-inline ' + (CURRENT_USER.role === 'User' ? 'role-user' : (CURRENT_USER.role === 'SuperAdmin' ? 'role-superadmin' : 'role-admin'));
  document.getElementById('submitTitle').textContent = 'ตัวชี้วัดของอำเภอ' + (CURRENT_USER.district || '');
  document.getElementById('sidebarUserName').textContent = (CURRENT_USER.displayName || CURRENT_USER.username) + ' (' + roleLabel + ')';
  document.getElementById('changePasswordMenuItem').classList.toggle('d-none', CURRENT_USER.role !== 'SuperAdmin');

  document.querySelectorAll('[data-role-tab]').forEach(function (el) {
    var roles = el.getAttribute('data-role-tab').split(',');
    el.classList.toggle('d-none', roles.indexOf(CURRENT_USER.role) === -1);
  });
  var firstVisibleBtn = document.querySelector('#mainTabs .nav-item:not(.d-none) button');
  document.querySelectorAll('#mainTabs button').forEach(function (b) { b.classList.remove('active'); });
  document.querySelectorAll('.tab-pane').forEach(function (p) { p.classList.remove('show', 'active'); });
  if (firstVisibleBtn) {
    firstVisibleBtn.classList.add('active');
    document.querySelector(firstVisibleBtn.getAttribute('data-bs-target')).classList.add('show', 'active');
    document.getElementById('topbarTitle').textContent = firstVisibleBtn.textContent.trim();
  }

  showLoading(true);
  try {
    BOOT = await apiGet('/api/bootstrap');
    showLoading(false);
    initRoleUI();
  } catch (e) {
    showLoading(false);
    showFatalError(e.message);
  }
}

async function askKpiResponsible() {
  var input = document.getElementById('kpiChatInput');
  var q = input.value.trim();
  var results = document.getElementById('kpiChatResults');
  if (!q) { return; }
  results.innerHTML = '<div class="text-center py-3"><div class="spinner-border spinner-border-sm text-success"></div></div>';
  try {
    const data = await apiGet('/api/kpi-responsible?q=' + encodeURIComponent(q));
    var matches = data.matches;
    if (!matches || !matches.length) {
      results.innerHTML = '<div class="chat-bubble-bot">ไม่พบตัวชี้วัดที่ตรงกับ "' + escapeHtml(q) + '" ลองพิมพ์คำอื่นดูครับ</div>';
      return;
    }
    results.innerHTML = matches.map(function (m) {
      var lines = [];
      if (m.reviewerName) lines.push('<strong>นักวิชาการผู้ตรวจ:</strong> ' + escapeHtml(m.reviewerName) + (m.reviewerContactEmail ? ' (' + escapeHtml(m.reviewerContactEmail) + ')' : ''));
      if (m.dataSourceContact) lines.push('<strong>ผู้ประสานงานข้อมูล:</strong> ' + escapeHtml(m.dataSourceContact));
      if (!lines.length) lines.push('<span class="text-muted">ยังไม่มีข้อมูลผู้รับผิดชอบสำหรับตัวชี้วัดนี้</span>');
      return '<div class="chat-bubble-bot mb-2"><div class="fw-semibold mb-1">' + escapeHtml(m.kpiName) + '</div>' + lines.join('<br>') + '</div>';
    }).join('');
  } catch (err) {
    results.innerHTML = '<div class="alert alert-danger small mb-0">' + escapeHtml(err.message) + '</div>';
  }
}

async function checkRoundDeadlinePopup() {
  try {
    const data = await apiGet('/api/public/round-info');
    var info = data.info;
    if (!info) return;
    var urgency = info.daysLeft <= 3 ? 'danger' : (info.daysLeft <= 7 ? 'warning' : 'info');
    var urgencyText = info.daysLeft < 0
      ? '<span class="text-danger fw-semibold">สิ้นสุดรอบไปแล้ว ' + Math.abs(info.daysLeft) + ' วัน</span>'
      : '<span class="fw-semibold">เหลืออีก ' + info.daysLeft + ' วัน</span>';
    document.getElementById('roundDeadlineBody').innerHTML =
      '<div class="alert alert-' + urgency + ' mb-3"><i class="bi bi-hourglass-split me-1"></i>ขณะนี้อยู่ในช่วงส่งและตรวจตัวชี้วัด</div>' +
      '<div class="mb-2"><strong>รอบปัจจุบัน:</strong> ' + escapeHtml(info.label) + '</div>' +
      '<div class="mb-2"><strong>สิ้นสุดวันที่:</strong> ' + escapeHtml(info.endDate) + '</div>' +
      '<div>' + urgencyText + '</div>';
    new bootstrap.Modal(document.getElementById('roundDeadlineModal')).show();
  } catch (e) { /* ไม่ต้องแจ้ง error ถ้าโหลดไม่สำเร็จ - ไม่ใช่ฟีเจอร์หลัก */ }
}

function initRoleUI() {
  var role = CURRENT_USER.role;
  if (role === 'User') loadMySubmissions();
  if (role === 'Admin') populateKpiSelect();
  if (role === 'SuperAdmin') { loadUserAccounts(); loadKpiSettings(); }
  loadDashboard();
  checkRoundDeadlinePopup();
}

function showFatalError(message) {
  renderTableError('submitTeamBody', message);
  renderTableError('submitIndivBody', message);
  renderTableError('reviewBody', message);
  var cards = document.getElementById('dashboardCards');
  if (cards) cards.innerHTML = '<div class="col-12"><div class="section-card p-4 text-center text-danger">' +
    '<i class="bi bi-exclamation-triangle"></i> เกิดข้อผิดพลาดในการโหลดระบบ: ' + escapeHtml(message) + '</div></div>';
  showToast('เกิดข้อผิดพลาด: ' + message, 'danger');
}

function closeSidebar() {
  document.getElementById('appSidebar').classList.remove('sidebar-open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
}

document.addEventListener('DOMContentLoaded', function () {
  loadPublicScoreChart();
  document.getElementById('loginSubmitBtn').addEventListener('click', handleLoginSubmit);
  document.getElementById('loginPassword').addEventListener('keydown', function (e) { if (e.key === 'Enter') handleLoginSubmit(); });
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.getElementById('openChangePasswordBtn').addEventListener('click', openChangePasswordModal);
  document.getElementById('submitChangePasswordBtn').addEventListener('click', submitChangePassword);

  document.getElementById('sidebarToggleBtn').addEventListener('click', function () {
    document.getElementById('appSidebar').classList.toggle('sidebar-open');
    document.getElementById('sidebarBackdrop').classList.toggle('show');
  });
  document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);
  document.querySelectorAll('#mainTabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.getElementById('topbarTitle').textContent = btn.textContent.trim();
      closeSidebar();
    });
  });

  var submitTab = document.getElementById('tab-submit');
  submitTab.addEventListener('click', function (e) {
    var uploadBtn = e.target.closest('[data-action="upload"]');
    var deleteBtn = e.target.closest('[data-action="delete-evidence"]');
    var aiBtn = e.target.closest('[data-action="ai-analyze-mine"]');
    var viewBtn = e.target.closest('[data-action="view-evidence"]');
    if (uploadBtn) handleUploadClick(uploadBtn.getAttribute('data-kpi-id'));
    if (deleteBtn) handleDeleteEvidenceClick(deleteBtn.getAttribute('data-kpi-id'));
    if (aiBtn) analyzeEvidenceForDistrict(CURRENT_USER.district, aiBtn.getAttribute('data-kpi-id'));
    if (viewBtn) openEvidence(CURRENT_USER.district, viewBtn.getAttribute('data-kpi-id'));
  });

  document.getElementById('tab-review').addEventListener('click', function (e) {
    var calcBtn = e.target.closest('[data-action="calc"]');
    var undoBtn = e.target.closest('[data-action="undo-score"]');
    var aiBtn = e.target.closest('[data-action="ai-analyze"]');
    var viewBtn = e.target.closest('[data-action="view-evidence"]');
    if (calcBtn) openCalculator(calcBtn.getAttribute('data-district'));
    if (undoBtn) undoScore(undoBtn.getAttribute('data-district'));
    if (aiBtn) analyzeEvidenceForDistrict(aiBtn.getAttribute('data-district'));
    if (viewBtn) openEvidence(viewBtn.getAttribute('data-district'), currentReviewKpiId);
  });
  document.getElementById('aiAnalysisReanalyzeBtn').addEventListener('click', forceReanalyzeEvidence);
  document.getElementById('kpiChatFab').addEventListener('click', function () {
    document.getElementById('kpiChatResults').innerHTML = '';
    document.getElementById('kpiChatInput').value = '';
    new bootstrap.Modal(document.getElementById('kpiChatModal')).show();
  });
  document.getElementById('kpiChatAskBtn').addEventListener('click', askKpiResponsible);
  document.getElementById('kpiChatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') askKpiResponsible(); });
  document.getElementById('kpiSelect').addEventListener('change', function (e) { loadReviewData(e.target.value); });
  document.getElementById('openSubmitScoresBtn').addEventListener('click', openSubmitScoresConfirm);
  document.getElementById('confirmSubmitScoresBtn').addEventListener('click', confirmSubmitScores);
  document.getElementById('dashboardKpiBreakdown').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="view-history"]');
    if (btn) openScoreHistory(btn.getAttribute('data-district'), btn.getAttribute('data-kpi-id'));
    var aiBtn = e.target.closest('[data-action="view-ai-insight"]');
    if (aiBtn) showAiInsight(aiBtn.getAttribute('data-district'), aiBtn.getAttribute('data-kpi-id'));
  });

  document.getElementById('userAccountsBody').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="regen-password"]');
    if (btn) regeneratePasswordFor(btn.getAttribute('data-username'));
  });
  document.getElementById('openCreateUserBtn').addEventListener('click', openCreateUserModal);
  document.getElementById('newRole').addEventListener('change', toggleNewUserDistrictField);
  document.getElementById('submitCreateUserBtn').addEventListener('click', submitCreateUser);
  document.getElementById('submitResetPasswordBtn').addEventListener('click', submitResetPassword);

  document.getElementById('tab-kpis').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="save-kpi-setting"]');
    if (btn) saveKpiSetting(btn.getAttribute('data-kpi-id'));
  });

  var calcApplyBtn = document.getElementById('calcApplyBtn');
  if (calcApplyBtn) {
    calcApplyBtn.addEventListener('click', function () {
      if (!currentCalcSuggestedScore) { showToast('กรุณากดคำนวณและตรวจสอบผลก่อน', 'warning'); return; }
      var sel = document.getElementById('score-' + currentCalcDistrict);
      if (sel) sel.value = String(currentCalcSuggestedScore);
      bootstrap.Modal.getInstance(document.getElementById('calcModal')).hide();
    });
  }

  (async function () {
    showLoading(true);
    try {
      const data = await apiGet('/api/auth/me');
      CURRENT_USER = data.user;
      showLoading(false);
      enterApp();
    } catch (e) {
      showLoading(false);
      showLoginScreen();
    }
  })();
});

// ---------- District: ส่งผลการปฏิบัติงาน ----------

function renderTableError(tbodyId, message) {
  var tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  var table = tbody.closest('table');
  var colspan = (table && table.querySelectorAll('thead th').length) || 7;
  tbody.innerHTML = '<tr><td colspan="' + colspan + '" class="text-center text-danger py-4">' +
    '<i class="bi bi-exclamation-triangle"></i> เกิดข้อผิดพลาด: ' + escapeHtml(message) + '</td></tr>';
}

async function loadMySubmissions() {
  showLoading(true);
  try {
    const data = await apiGet('/api/my-evaluation');
    showLoading(false);
    renderSubmitRows(data.rows);
  } catch (err) {
    showLoading(false);
    renderTableError('submitTeamBody', err.message);
    renderTableError('submitIndivBody', err.message);
  }
}

function renderSubmitRows(rows) {
  if (!Array.isArray(rows)) throw new Error('เซิร์ฟเวอร์ส่งค่ากลับมาไม่ถูกต้อง');
  LAST_MY_SUBMISSION_ROWS = rows;
  var teamRows = rows.filter(function (r) { return r.category === 'TEAM'; });
  var indivRows = rows.filter(function (r) { return r.category === 'INDIVIDUAL'; });
  document.getElementById('submitTeamBody').innerHTML = teamRows.map(submitRowHtml).join('');
  document.getElementById('submitIndivBody').innerHTML = indivRows.map(submitRowHtml).join('');
  var submitted = rows.filter(function (r) { return r.status !== 'ยังไม่ส่ง'; }).length;
  var reviewed = rows.filter(function (r) { return r.status === 'ตรวจแล้ว'; }).length;
  var notSubmitted = rows.length - submitted;
  document.getElementById('submitStats').innerHTML =
    statTileHtml('a', 'bi-cloud-upload-fill', 'ส่งหลักฐานแล้ว', submitted + '/' + rows.length, 'จากทั้งหมด ' + rows.length + ' ตัวชี้วัด', 'col-md-4') +
    statTileHtml('d', 'bi-check2-circle', 'ตรวจให้คะแนนแล้ว', reviewed + '/' + rows.length, 'โดยนักวิชาการผู้รับผิดชอบ', 'col-md-4') +
    statTileHtml(notSubmitted > 0 ? 'b' : 'a', 'bi-exclamation-circle', 'ยังไม่ได้ส่ง', notSubmitted, notSubmitted > 0 ? 'กรุณาอัปโหลดหลักฐานให้ครบ' : 'ส่งครบทุกตัวชี้วัดแล้ว', 'col-md-4');
}

function kpiLevelsTableHtml(levels) {
  return '<tr><th>ระดับคะแนน</th><th>รายละเอียดตัวชี้วัด</th></tr>' + (levels || []).map(function (lv, i) {
    return '<tr><td><strong>ระดับค่าคะแนนที่ ' + (i + 1) + '</strong></td><td>' + escapeHtml(lv) + '</td></tr>';
  }).join('');
}

function kpiCriteriaDetailsHtml(r) {
  var footerHtml = (r.dataSource || r.contact)
    ? '<div class="kpi-criteria-footer">' +
      (r.dataSource ? 'แหล่งข้อมูล: ' + escapeHtml(r.dataSource) + '<br>' : '') +
      (r.contact ? 'ผู้ประสานงาน: ' + escapeHtml(r.contact) : '') +
      '</div>'
    : '';
  return '<details class="kpi-criteria">' +
    '<summary>ดูเกณฑ์การให้คะแนน 5 ระดับ</summary>' +
    '<table class="kpi-criteria-table">' + kpiLevelsTableHtml(r.levels) + '</table>' +
    footerHtml +
    '</details>';
}

function kpiInfoCellHtml(r) {
  return '<div class="kpi-name">' + escapeHtml(r.kpiName) + '</div>' +
    (r.kpiNote ? '<div class="kpi-meta">' + escapeHtml(r.kpiNote) + '</div>' : '') +
    kpiCriteriaDetailsHtml(r);
}

function submitRowHtml(r) {
  var evidenceHtml, uploadCellHtml;
  if (r.requiresEvidence === false) {
    evidenceHtml = '<span class="text-muted">ไม่ต้องแนบ</span>';
    uploadCellHtml = '<span class="small text-muted">ประเมินจากข้อมูลภายนอก</span>';
  } else {
    var aiSelfCheckBtn = '<button type="button" class="btn btn-sm ' + (r.aiConsistency ? 'btn-info' : 'btn-outline-info') + '" data-action="ai-analyze-mine" data-kpi-id="' + r.kpiId + '" title="' + (r.aiConsistency ? escapeAttr('ตรวจแล้ว: ' + r.aiConsistency + ' (คลิกดูผล)') : 'ให้ AI ตรวจเบื้องต้นก่อนส่งจริง') + '"><i class="bi bi-robot"></i></button>';
    evidenceHtml = (r.evidenceFileName || r.evidenceLink)
      ? '<div class="evidence-file">' +
        (r.evidenceFileName
          ? '<a href="javascript:void(0)" data-action="view-evidence" data-kpi-id="' + r.kpiId + '">' + escapeHtml(r.evidenceFileName) + '</a>'
          : '<a href="' + escapeAttr(r.evidenceLink) + '" target="_blank" rel="noopener">เปิดลิงก์</a>') +
        aiSelfCheckBtn +
        '<button type="button" class="btn btn-sm btn-outline-danger btn-delete-evidence" data-action="delete-evidence" data-kpi-id="' + r.kpiId + '" title="ลบไฟล์นี้"><i class="bi bi-trash"></i></button>' +
        '</div>'
      : '<span class="text-muted">ยังไม่มี</span>';
    uploadCellHtml = '<input type="file" class="form-control form-control-sm mb-1" id="fileInput-' + r.kpiId + '">' +
      '<button class="btn btn-sm text-white w-100" style="background:var(--brand)" data-action="upload" data-kpi-id="' + r.kpiId + '">' +
      '<i class="bi bi-cloud-upload"></i> อัปโหลด</button>';
  }
  var noteHtml = r.note ? escapeHtml(r.note) : '<span class="text-muted">-</span>';
  var scoreText = r.score
    ? '<span class="kpi-score kpi-' + scoreChipClass(r.score) + '">' + r.score + '</span><span class="text-muted small"> / 5</span>'
    : '<span class="text-muted">-</span>';
  var trAttr = r.status === 'ยังไม่ส่ง' ? ' class="kpi-row-pending"' : '';

  return '<tr' + trAttr + '>' +
    '<td style="min-width:260px">' + kpiInfoCellHtml(r) + '</td>' +
    '<td><span class="weight-pill">' + r.weight + '%</span></td>' +
    '<td>' + statusBadgeHtml(r.status) + '</td>' +
    '<td>' + scoreText + '</td>' +
    '<td>' + evidenceHtml + '</td>' +
    '<td>' + noteHtml + '</td>' +
    '<td>' + uploadCellHtml + '</td>' +
    '</tr>';
}

async function openEvidence(district, kpiId) {
  try {
    const data = await apiGet('/api/evidence/url?district=' + encodeURIComponent(district) + '&kpi_id=' + encodeURIComponent(kpiId));
    window.open(data.url, '_blank', 'noopener');
  } catch (err) {
    showToast('เปิดไฟล์ไม่สำเร็จ: ' + err.message, 'danger');
  }
}

async function handleDeleteEvidenceClick(kpiId) {
  if (!confirm('ยืนยันการลบไฟล์หลักฐานนี้?\n\nการลบจะรีเซ็ตสถานะ/คะแนนของตัวชี้วัดนี้กลับเป็น "ยังไม่ส่ง"')) return;
  showLoading(true);
  try {
    await apiDelete('/api/evidence', { kpi_id: kpiId });
    showLoading(false);
    showToast('ลบหลักฐานเรียบร้อยแล้ว', 'success');
    loadMySubmissions();
  } catch (err) {
    showLoading(false);
    onServerError(err);
  }
}

async function handleUploadClick(kpiId) {
  var input = document.getElementById('fileInput-' + kpiId);
  var file = input.files[0];
  if (!file) { showToast('กรุณาเลือกไฟล์ก่อน', 'warning'); return; }
  var MAX_SIZE = 15 * 1024 * 1024;
  if (file.size > MAX_SIZE) { showToast('ไฟล์ใหญ่เกินไป (จำกัด 15MB)', 'danger'); return; }

  showLoading(true);
  try {
    var formData = new FormData();
    formData.append('kpi_id', kpiId);
    formData.append('file', file);
    await apiFetch('/api/evidence/submit', { method: 'POST', body: formData });
    showLoading(false);
    showToast('อัปโหลดสำเร็จ: ' + file.name, 'success');
    loadMySubmissions();
  } catch (err) {
    showLoading(false);
    onServerError(err);
  }
}

// ---------- Admin (นักวิชาการ): ตรวจให้คะแนน ----------

async function populateKpiSelect() {
  try {
    const data = await apiGet('/api/my-assigned-kpis');
    var kpis = data.kpis;
    var sel = document.getElementById('kpiSelect');
    if (kpis.length === 0) {
      sel.innerHTML = '';
      renderTableError('reviewBody', 'ยังไม่ได้รับมอบหมายตัวชี้วัดใดให้ตรวจ กรุณาติดต่อผู้ดูแลระบบ');
      document.getElementById('reviewKpiInfo').innerHTML = '';
      return;
    }
    sel.innerHTML = kpis.map(function (k) {
      return '<option value="' + escapeAttr(k.id) + '">' + escapeHtml(formatKpiIdLabel(k.id)) + ' — ' + escapeHtml(k.name) + '</option>';
    }).join('');
    loadReviewData(sel.value);
  } catch (err) {
    renderTableError('reviewBody', err.message);
  }
}

async function loadReviewData(kpiId) {
  if (!kpiId) return;
  currentReviewKpiId = kpiId;
  showLoading(true);
  try {
    const data = await apiGet('/api/review/' + encodeURIComponent(kpiId));
    showLoading(false);
    renderReviewData(data);
  } catch (err) {
    showLoading(false);
    renderTableError('reviewBody', err.message);
  }
}

function renderReviewData(data) {
  var kpi = data.kpi;
  currentReviewRequiresEvidence = kpi.requiresEvidence !== false;
  var badgeHtml = kpi.requiresEvidence
    ? ''
    : '<span class="badge bg-info text-dark ms-1">ไม่ต้องแนบหลักฐาน — ประเมินจากข้อมูลภายนอก</span>';
  document.getElementById('reviewKpiInfo').innerHTML = kpiInfoCellHtml({ kpiName: kpi.name, kpiNote: kpi.note, levels: kpi.levels, dataSource: kpi.dataSource, contact: kpi.contact }) +
    '<div class="mt-2"><span class="weight-pill">น้ำหนัก ' + kpi.weight + '%</span>' + badgeHtml + '</div>';

  var rows = data.districts;
  LAST_REVIEW_ROWS = rows;
  document.getElementById('reviewBody').innerHTML = rows.map(reviewRowHtml).join('');
  var reviewed = rows.filter(function (r) { return r.status === 'ตรวจแล้ว'; }).length;
  var pending = rows.filter(function (r) { return r.status === 'รอตรวจ'; }).length;
  var notSubmitted = rows.filter(function (r) { return r.status === 'ยังไม่ส่ง'; }).length;
  document.getElementById('reviewStats').innerHTML =
    statTileHtml('a', 'bi-check2-circle', 'ตรวจแล้ว', reviewed + '/' + rows.length, 'อำเภอที่ให้คะแนนแล้ว', 'col-md-4') +
    statTileHtml(pending > 0 ? 'b' : 'a', 'bi-hourglass-split', 'รอตรวจ', pending, 'ส่งหลักฐานแล้ว รอให้คะแนน', 'col-md-4') +
    statTileHtml('c', 'bi-envelope-slash', 'ยังไม่ส่งหลักฐาน', notSubmitted, 'อำเภอที่ยังไม่ส่ง', 'col-md-4');
}

function reviewRowHtml(r) {
  var evidenceHtml;
  if (r.evidenceLink || r.evidenceFileName) {
    var aiChecked = !!r.aiConsistency;
    var aiBtnCls = aiChecked ? 'btn-info' : 'btn-outline-info';
    var aiBtnTitle = aiChecked ? ('ตรวจแล้ว: ' + r.aiConsistency + ' (คลิกดูผลที่บันทึกไว้)') : 'ให้ AI ช่วยดูหลักฐานเบื้องต้น (ไม่ตัดสินคะแนน)';
    evidenceHtml = (r.evidenceFileName
      ? '<a href="javascript:void(0)" data-action="view-evidence" data-district="' + escapeAttr(r.district) + '">' + escapeHtml(r.evidenceFileName) + '</a>'
      : '<a href="' + escapeAttr(r.evidenceLink) + '" target="_blank" rel="noopener">เปิดลิงก์</a>') +
      '<button type="button" class="btn btn-sm ' + aiBtnCls + ' py-0 px-1 ms-1" data-action="ai-analyze" data-district="' + r.district + '" title="' + escapeAttr(aiBtnTitle) + '"><i class="bi bi-robot"></i></button>';
  } else if (!currentReviewRequiresEvidence) {
    evidenceHtml = '<span class="text-muted small">ไม่ต้องแนบหลักฐาน — ประเมินจากข้อมูลภายนอก</span>';
  } else {
    evidenceHtml = '<span class="text-warning small">กรุณาแนบหลักฐาน</span>';
  }
  var options = [1, 2, 3, 4, 5].map(function (n) {
    return '<option value="' + n + '"' + (Number(r.score) === n ? ' selected' : '') + '>' + n + '</option>';
  }).join('');
  var calcBtn = CALC_ENABLED.indexOf(currentReviewKpiId) !== -1
    ? '<button type="button" class="btn btn-sm btn-outline-secondary mt-1 w-100" data-action="calc" data-district="' + r.district + '" title="ตัวช่วยคำนวณ"><i class="bi bi-calculator"></i></button>'
    : '';
  var undoBtn = r.status === 'ตรวจแล้ว'
    ? '<button class="btn btn-sm btn-outline-danger mt-1" data-action="undo-score" data-district="' + r.district + '" title="ยกเลิกการตรวจ (กลับเป็นรอตรวจ)"><i class="bi bi-arrow-counterclockwise"></i></button>'
    : '';
  var trAttr = r.status === 'รอตรวจ' ? ' class="kpi-row-pending"' : '';
  return '<tr' + trAttr + '>' +
    '<td class="fw-semibold"><i class="bi bi-signpost-split text-muted me-1"></i>' + escapeHtml(r.district) + '</td>' +
    '<td>' + statusBadgeHtml(r.status) + '</td>' +
    '<td>' + evidenceHtml + '</td>' +
    '<td><select class="form-select form-select-sm" id="score-' + r.district + '"><option value="">-</option>' + options + '</select>' + calcBtn + '</td>' +
    '<td><textarea class="form-control form-control-sm" id="note-' + r.district + '" rows="1">' + escapeHtml(r.note) + '</textarea></td>' +
    '<td>' + undoBtn + '</td>' +
    '</tr>';
}

var pendingScoreEntries = [];

function openSubmitScoresConfirm() {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#reviewBody tr'));
  var entries = [];
  rows.forEach(function (row) {
    var scoreSelect = row.querySelector('select[id^="score-"]');
    if (!scoreSelect) return;
    var district = scoreSelect.id.slice('score-'.length);
    var score = scoreSelect.value;
    if (!score) return;
    var noteEl = document.getElementById('note-' + district);
    var wasReviewed = !!row.querySelector('[data-action="undo-score"]');
    entries.push({ district: district, score: score, note: noteEl ? noteEl.value : '', wasReviewed: wasReviewed });
  });
  if (!entries.length) { showToast('ยังไม่ได้เลือกคะแนนให้อำเภอใดเลย', 'warning'); return; }

  pendingScoreEntries = entries;
  var kpiSelect = document.getElementById('kpiSelect');
  var kpiLabel = kpiSelect.selectedOptions.length ? kpiSelect.selectedOptions[0].textContent : '';
  document.getElementById('confirmSubmitScoresKpiLabel').textContent = 'ตัวชี้วัด: ' + kpiLabel;
  document.getElementById('confirmSubmitScoresBody').innerHTML = entries.map(function (en) {
    return '<tr><td>' + escapeHtml(en.district) + '</td><td>' + en.score + ' / 5</td>' +
      '<td>' + (en.note ? escapeHtml(en.note) : '<span class="text-muted">-</span>') + '</td>' +
      '<td>' + (en.wasReviewed ? '<span class="badge bg-warning text-dark">แก้ไขจากคะแนนเดิม</span>' : '<span class="badge bg-secondary">ให้คะแนนใหม่</span>') + '</td></tr>';
  }).join('');
  document.getElementById('submitScoresProgress').classList.add('d-none');
  document.getElementById('confirmSubmitScoresBtn').disabled = false;
  new bootstrap.Modal(document.getElementById('confirmSubmitScoresModal')).show();
}

async function confirmSubmitScores() {
  var btn = document.getElementById('confirmSubmitScoresBtn');
  btn.disabled = true;
  var progressEl = document.getElementById('submitScoresProgress');
  progressEl.classList.remove('d-none');
  var total = pendingScoreEntries.length;
  var successCount = 0, failCount = 0, failedDistricts = [];

  for (var i = 0; i < total; i++) {
    var entry = pendingScoreEntries[i];
    progressEl.textContent = 'กำลังส่งคะแนน ' + (i + 1) + '/' + total + ' (' + entry.district + ')...';
    try {
      await apiPost('/api/evaluation/score', { district: entry.district, kpi_id: currentReviewKpiId, score: Number(entry.score), note: entry.note });
      successCount++;
    } catch (e) {
      failCount++;
      failedDistricts.push(entry.district);
    }
  }

  btn.disabled = false;
  bootstrap.Modal.getInstance(document.getElementById('confirmSubmitScoresModal')).hide();
  if (failCount === 0) {
    showToast('ส่งคะแนนเข้าสู่ส่วนกลางสำเร็จทั้งหมด ' + successCount + ' อำเภอ', 'success');
  } else {
    showToast('ส่งคะแนนสำเร็จ ' + successCount + ' อำเภอ, ไม่สำเร็จ ' + failCount + ' อำเภอ (' + failedDistricts.join(', ') + ')', 'danger');
  }
  loadReviewData(currentReviewKpiId);
  loadDashboard();
}

async function undoScore(district) {
  showLoading(true);
  try {
    await apiPost('/api/evaluation/undo', { district: district, kpi_id: currentReviewKpiId });
    showLoading(false);
    showToast('สถานะกลับเป็น "รอตรวจ" แล้ว (ล้างคะแนน/หมายเหตุเดิมทิ้ง)', 'success');
    loadReviewData(currentReviewKpiId);
    loadDashboard();
  } catch (err) {
    showLoading(false);
    onServerError(err);
  }
}

// ---------- AI ช่วยตรวจหลักฐาน (Advisory เท่านั้น) ----------

var currentAiAnalysisDistrict = null;
var currentAiAnalysisKpiId = null;

function aiAnalysisResultHtml(result, cachedAt) {
  var consistencyBadgeMap = {
    'สอดคล้อง': '<span class="badge bg-success">สอดคล้อง</span>',
    'ไม่แน่ใจ': '<span class="badge bg-warning text-dark">ไม่แน่ใจ</span>',
    'ไม่สอดคล้อง': '<span class="badge bg-danger">ไม่สอดคล้อง</span>'
  };
  var consistencyBadge = consistencyBadgeMap[result.consistency] || escapeHtml(result.consistency || '-');
  var obsHtml = (result.observations && result.observations.length)
    ? '<ul class="mb-0">' + result.observations.map(function (o) { return '<li>' + escapeHtml(o) + '</li>'; }).join('') + '</ul>'
    : '<span class="text-muted small">ไม่มีจุดสังเกตพิเศษ</span>';
  var recHtml = (result.recommendations && result.recommendations.length)
    ? '<ul class="mb-0">' + result.recommendations.map(function (r) { return '<li>' + escapeHtml(r) + '</li>'; }).join('') + '</ul>'
    : '<span class="text-muted small">หลักฐานสอดคล้องและครบถ้วนดีแล้ว ไม่มีข้อเสนอแนะเพิ่มเติม</span>';
  var cachedNote = cachedAt
    ? '<div class="alert alert-light border small mb-3 py-2"><i class="bi bi-clock-history me-1"></i>ผลตรวจนี้บันทึกไว้จากการตรวจเมื่อ ' + formatDateTimeClient(cachedAt) + ' — ไม่ได้เรียก AI ใหม่ (กด "ตรวจใหม่" หากต้องการวิเคราะห์ซ้ำ)</div>'
    : '';
  return cachedNote +
    '<div class="alert alert-secondary small mb-3"><i class="bi bi-info-circle me-1"></i>ข้อมูลจาก AI เพื่อประกอบการพิจารณาเท่านั้น ไม่ใช่การตัดสินคะแนน — นักวิชาการเป็นผู้ตัดสินใจขั้นสุดท้ายเสมอ</div>' +
    '<div class="mb-2"><strong>ไฟล์:</strong> ' + escapeHtml(result.fileName || '-') + '</div>' +
    '<div class="mb-2"><strong>ความสอดคล้องกับเกณฑ์ตัวชี้วัด:</strong> ' + consistencyBadge + '</div>' +
    '<div class="mb-2"><strong>สรุปเนื้อหา:</strong><p class="mb-0">' + escapeHtml(result.summary || '-') + '</p></div>' +
    '<div class="mb-2"><strong>จุดสังเกต:</strong>' + obsHtml + '</div>' +
    '<div class="mb-0"><strong><i class="bi bi-lightbulb text-warning"></i> ข้อเสนอแนะการพัฒนา/ปรับปรุงสำหรับอำเภอ:</strong>' + recHtml + '</div>';
}

function findCachedAiRow(district, kpiId) {
  var inReview = (LAST_REVIEW_ROWS || []).find(function (r) { return r.district === district; });
  if (inReview && inReview.aiConsistency) return inReview;
  var inSubmit = (LAST_MY_SUBMISSION_ROWS || []).find(function (r) { return r.district === district && r.kpiId === kpiId; });
  if (inSubmit && inSubmit.aiConsistency) return inSubmit;
  return null;
}

function analyzeEvidenceForDistrict(district, kpiId) {
  currentAiAnalysisDistrict = district;
  currentAiAnalysisKpiId = kpiId || currentReviewKpiId;
  document.getElementById('aiAnalysisDistrictLabel').textContent = district;
  new bootstrap.Modal(document.getElementById('aiAnalysisModal')).show();

  var cached = findCachedAiRow(district, currentAiAnalysisKpiId);
  if (cached) {
    document.getElementById('aiAnalysisBody').innerHTML = aiAnalysisResultHtml({
      consistency: cached.aiConsistency,
      summary: cached.aiSummary,
      observations: cached.aiObservations,
      recommendations: cached.aiRecommendations,
      fileName: cached.evidenceFileName
    }, cached.aiCheckedAt);
    document.getElementById('aiAnalysisReanalyzeBtn').classList.remove('d-none');
    return;
  }
  runAiAnalysis(district, currentAiAnalysisKpiId);
}

function forceReanalyzeEvidence() {
  if (currentAiAnalysisDistrict) runAiAnalysis(currentAiAnalysisDistrict, currentAiAnalysisKpiId);
}

async function runAiAnalysis(district, kpiId) {
  var modalBody = document.getElementById('aiAnalysisBody');
  document.getElementById('aiAnalysisReanalyzeBtn').classList.add('d-none');
  modalBody.innerHTML = '<div class="text-center py-4"><div class="spinner-border text-info" role="status"></div>' +
    '<p class="mt-2 text-muted small">AI กำลังอ่านหลักฐาน กรุณารอสักครู่...</p></div>';

  try {
    const result = await apiPost('/api/ai/analyze-evidence', { district: district, kpi_id: kpiId });
    modalBody.innerHTML = aiAnalysisResultHtml(result, null);
    document.getElementById('aiAnalysisReanalyzeBtn').classList.remove('d-none');

    var reviewRow = (LAST_REVIEW_ROWS || []).find(function (r) { return r.district === district; });
    if (reviewRow) {
      reviewRow.aiConsistency = result.consistency;
      reviewRow.aiSummary = result.summary;
      reviewRow.aiObservations = result.observations || [];
      reviewRow.aiRecommendations = result.recommendations || [];
      reviewRow.aiCheckedAt = Date.now();
      var reviewBody = document.getElementById('reviewBody');
      if (reviewBody) reviewBody.innerHTML = LAST_REVIEW_ROWS.map(reviewRowHtml).join('');
    }
    var submitRow = (LAST_MY_SUBMISSION_ROWS || []).find(function (r) { return r.district === district && r.kpiId === kpiId; });
    if (submitRow) {
      submitRow.aiConsistency = result.consistency;
      submitRow.aiSummary = result.summary;
      submitRow.aiObservations = result.observations || [];
      submitRow.aiRecommendations = result.recommendations || [];
      submitRow.aiCheckedAt = Date.now();
      renderSubmitRows(LAST_MY_SUBMISSION_ROWS);
    }
  } catch (err) {
    modalBody.innerHTML = '<div class="alert alert-danger mb-0">' + escapeHtml(err.message) + '</div>';
  }
}

async function loadProvinceAiInsight() {
  var card = document.getElementById('provinceAiInsightCard');
  card.classList.remove('d-none');
  card.innerHTML = '<div class="section-card p-3 mb-4 text-center py-4"><div class="spinner-border text-info" role="status"></div>' +
    '<p class="mt-2 text-muted small mb-0">AI กำลังสรุปภาพรวมทั้งจังหวัด กรุณารอสักครู่...</p></div>';

  try {
    const result = await apiPost('/api/ai/province-narrative');
    function listHtml(items, emptyText) {
      return (items && items.length)
        ? '<ul class="mb-0">' + items.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul>'
        : '<span class="text-muted small">' + escapeHtml(emptyText) + '</span>';
    }
    card.innerHTML = '<div class="section-card p-3 mb-4">' +
      '<div class="section-card-header"><i class="bi bi-robot"></i> AI สรุปภาพรวมจังหวัด (จากคะแนนที่นักวิชาการให้ไว้แล้ว)</div>' +
      '<div class="p-3">' +
      '<div class="alert alert-secondary small mb-3"><i class="bi bi-info-circle me-1"></i>เป็นการสรุปเชิงบรรยายจากคะแนนที่มีอยู่แล้วเท่านั้น ไม่ใช่การตัดสินคะแนนใหม่</div>' +
      '<div class="row g-3">' +
      '<div class="col-md-4"><h6 class="text-success"><i class="bi bi-check-circle-fill"></i> จุดแข็งของจังหวัด</h6>' + listHtml(result.strengths, 'ไม่มีข้อมูลเพียงพอ') + '</div>' +
      '<div class="col-md-4"><h6 class="text-danger"><i class="bi bi-exclamation-triangle-fill"></i> จุดอ่อนของจังหวัด</h6>' + listHtml(result.weaknesses, 'ไม่มีข้อมูลเพียงพอ') + '</div>' +
      '<div class="col-md-4"><h6 class="text-warning"><i class="bi bi-lightbulb-fill"></i> ควรโฟกัสเป็นพิเศษ</h6>' + listHtml(result.focusAreas, 'ไม่มีข้อมูลเพียงพอ') + '</div>' +
      '</div></div></div>';
  } catch (err) {
    card.innerHTML = '<div class="alert alert-danger">' + escapeHtml(err.message) + '</div>';
  }
}

// ---------- SuperAdmin: จัดการผู้ใช้งาน ----------

async function loadUserAccounts() {
  try {
    const data = await apiGet('/api/admin/users');
    renderUserAccounts(data.users);
  } catch (err) {
    renderTableError('userAccountsBody', err.message);
  }
}

function userRolePillHtml(u) {
  if (u.role === 'SuperAdmin') return '<span class="role-pill role-superadmin"><i class="bi bi-shield-lock-fill"></i> ผู้ดูแลระบบ</span>';
  if (u.role === 'Admin') return '<span class="role-pill role-admin"><i class="bi bi-mortarboard-fill"></i> นักวิชาการ</span>';
  return '<span class="role-pill role-user"><i class="bi bi-signpost-split-fill"></i> อำเภอ' + escapeHtml(u.district || '') + '</span>';
}

function renderUserAccounts(users) {
  var superAdminCount = users.filter(function (u) { return u.role === 'SuperAdmin'; }).length;
  var adminCount = users.filter(function (u) { return u.role === 'Admin'; }).length;
  var userCount = users.filter(function (u) { return u.role === 'User'; }).length;
  document.getElementById('userAccountsStats').innerHTML =
    statTileHtml('a', 'bi-people-fill', 'บัญชีทั้งหมด', users.length, 'ในระบบ', 'col-md-3') +
    statTileHtml('c', 'bi-shield-lock-fill', 'ผู้ดูแลระบบ', superAdminCount, 'SuperAdmin', 'col-md-3') +
    statTileHtml('b', 'bi-mortarboard-fill', 'นักวิชาการ', adminCount, 'ผู้รับผิดชอบตรวจตัวชี้วัด', 'col-md-3') +
    statTileHtml('d', 'bi-signpost-split-fill', 'อำเภอ', userCount, 'จาก ' + (BOOT.districts || []).length + ' อำเภอ', 'col-md-3');

  document.getElementById('userAccountsBody').innerHTML = users.map(function (u) {
    var initial = (u.displayName || u.username || '?').trim().charAt(0).toUpperCase();
    return '<tr>' +
      '<td><div class="d-flex align-items-center gap-2">' +
      '<span class="account-avatar-sm">' + escapeHtml(initial) + '</span>' +
      '<div><div class="fw-semibold">' + escapeHtml(u.displayName || u.username) + '</div>' +
      '<div class="small text-muted">' + escapeHtml(u.username) + '</div></div>' +
      '</div></td>' +
      '<td>' + userRolePillHtml(u) + '</td>' +
      '<td>' + escapeHtml(u.contactEmail || '-') + '</td>' +
      '<td><button class="btn btn-sm btn-outline-secondary" data-action="regen-password" data-username="' + escapeAttr(u.username) + '">รีเซ็ตรหัสผ่าน</button></td>' +
      '</tr>';
  }).join('');
}

function openCreateUserModal() {
  document.getElementById('newUsername').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('newDisplayName').value = '';
  document.getElementById('newRole').value = 'User';
  document.getElementById('newContactEmail').value = '';
  var distSel = document.getElementById('newDistrict');
  distSel.innerHTML = (BOOT.districts || []).map(function (d) { return '<option value="' + escapeAttr(d) + '">' + escapeHtml(d) + '</option>'; }).join('');
  toggleNewUserDistrictField();
  new bootstrap.Modal(document.getElementById('createUserModal')).show();
}

function toggleNewUserDistrictField() {
  document.getElementById('newDistrictWrap').classList.toggle('d-none', document.getElementById('newRole').value !== 'User');
}

async function submitCreateUser() {
  var payload = {
    username: document.getElementById('newUsername').value.trim(),
    password: document.getElementById('newPassword').value,
    displayName: document.getElementById('newDisplayName').value.trim(),
    role: document.getElementById('newRole').value,
    district: document.getElementById('newDistrict').value,
    contactEmail: document.getElementById('newContactEmail').value.trim()
  };
  if (payload.password.length < 6) { showToast('กรุณาตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร', 'danger'); return; }
  showLoading(true);
  try {
    const result = await apiPost('/api/admin/users', payload);
    showLoading(false);
    bootstrap.Modal.getInstance(document.getElementById('createUserModal')).hide();
    showGeneratedPassword(result.username, result.password);
    loadUserAccounts();
  } catch (err) {
    showLoading(false);
    showToast('เกิดข้อผิดพลาด: ' + err.message, 'danger');
  }
}

var resetPasswordTargetUsername = null;

function regeneratePasswordFor(username) {
  resetPasswordTargetUsername = username;
  document.getElementById('resetPasswordUsernameLabel').textContent = username;
  document.getElementById('rpNewPassword').value = '';
  new bootstrap.Modal(document.getElementById('resetPasswordModal')).show();
}

async function submitResetPassword() {
  var newPassword = document.getElementById('rpNewPassword').value;
  if (newPassword.length < 6) { showToast('กรุณาตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร', 'danger'); return; }
  showLoading(true);
  try {
    const result = await apiPost('/api/admin/users/' + encodeURIComponent(resetPasswordTargetUsername) + '/reset-password', { newPassword: newPassword });
    showLoading(false);
    bootstrap.Modal.getInstance(document.getElementById('resetPasswordModal')).hide();
    showGeneratedPassword(result.username, result.password);
  } catch (err) {
    showLoading(false);
    showToast('เกิดข้อผิดพลาด: ' + err.message, 'danger');
  }
}

function showGeneratedPassword(username, password) {
  document.getElementById('generatedPasswordText').textContent = 'Username: ' + username + '   Password: ' + password;
  new bootstrap.Modal(document.getElementById('passwordRevealModal')).show();
}

// ---------- SuperAdmin: จัดการตัวชี้วัด ----------

async function loadKpiSettings() {
  try {
    const data = await apiGet('/api/admin/reviewers');
    kpiSettingsReviewers = data.reviewers;
  } catch (e) {
    kpiSettingsReviewers = [];
  }
  try {
    const data = await apiGet('/api/kpi');
    window._kpiSettingsData = data.kpis;
    refreshKpiSettingsTable();
  } catch (err) {
    renderTableError('kpiSettingsTeamBody', err.message);
    renderTableError('kpiSettingsIndivBody', err.message);
  }
}

function refreshKpiSettingsTable() {
  if (!window._kpiSettingsData) return;
  var data = window._kpiSettingsData;
  var teamKpis = data.filter(function (k) { return k.category === 'TEAM'; });
  var indivKpis = data.filter(function (k) { return k.category !== 'TEAM'; });
  var unassignedCount = data.filter(function (k) { return !k.assignedReviewerUsername; }).length;
  var evidenceCount = data.filter(function (k) { return k.requiresEvidence; }).length;

  document.getElementById('kpiSettingsStats').innerHTML =
    statTileHtml('a', 'bi-collection', 'ตัวชี้วัดทั้งหมด', data.length, 'ทีม ' + teamKpis.length + ' + รายบุคคล ' + indivKpis.length, 'col-md-4') +
    statTileHtml(unassignedCount > 0 ? 'b' : 'a', 'bi-person-check-fill', 'มอบหมายผู้ตรวจแล้ว', (data.length - unassignedCount) + '/' + data.length,
      unassignedCount > 0 ? ('เหลือ ' + unassignedCount + ' ตัวชี้วัดยังไม่มอบหมาย') : 'ครบทุกตัวชี้วัดแล้ว', 'col-md-4') +
    statTileHtml('c', 'bi-shield-check', 'ต้องแนบหลักฐาน', evidenceCount + '/' + data.length, 'ตัวชี้วัดที่ต้องอัปโหลดไฟล์', 'col-md-4');

  function kpiSettingRowHtml(k) {
    var reviewerOptions = '<option value="">— ยังไม่มอบหมาย —</option>' + kpiSettingsReviewers.map(function (rv) {
      return '<option value="' + escapeAttr(rv.username) + '"' + (rv.username === k.assignedReviewerUsername ? ' selected' : '') + '>' +
        escapeHtml(rv.displayName || rv.username) + '</option>';
    }).join('');
    var trAttr = !k.assignedReviewerUsername ? ' class="kpi-row-pending"' : '';
    return '<tr' + trAttr + '>' +
      '<td><div class="fw-semibold">' + escapeHtml(formatKpiIdLabel(k.id)) + '</div><div class="small text-muted">' + escapeHtml(k.name) + '</div>' +
      kpiCriteriaDetailsHtml({ levels: k.levels, dataSource: k.dataSource, contact: k.contact }) +
      '</td>' +
      '<td><span class="weight-pill">' + k.weight + '%</span></td>' +
      '<td><div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="req-' + k.id + '"' + (k.requiresEvidence ? ' checked' : '') + '></div></td>' +
      '<td><select class="form-select form-select-sm" id="reviewer-' + k.id + '">' + reviewerOptions + '</select></td>' +
      '<td><button class="btn btn-sm btn-success" data-action="save-kpi-setting" data-kpi-id="' + k.id + '" title="บันทึก"><i class="bi bi-check2"></i></button></td>' +
      '</tr>';
  }

  document.getElementById('kpiSettingsTeamBody').innerHTML = teamKpis.map(kpiSettingRowHtml).join('');
  document.getElementById('kpiSettingsIndivBody').innerHTML = indivKpis.map(kpiSettingRowHtml).join('');
}

async function saveKpiSetting(kpiId) {
  var requiresEvidence = document.getElementById('req-' + kpiId).checked;
  var reviewer = document.getElementById('reviewer-' + kpiId).value;
  showLoading(true);
  try {
    await apiPost('/api/admin/kpi-settings/' + encodeURIComponent(kpiId), { requiresEvidence: requiresEvidence, assignedReviewerUsername: reviewer });
    showLoading(false);
    showToast('บันทึกการตั้งค่าแล้ว', 'success');
    loadKpiSettings();
  } catch (err) {
    showLoading(false);
    onServerError(err);
  }
}

// ---------- ตัวช่วยคำนวณคะแนน ----------

function openCalculator(district) {
  currentCalcDistrict = district;
  currentCalcSuggestedScore = null;
  document.getElementById('calcResultText').textContent = '';
  document.getElementById('calcModalBody').innerHTML = calcFormHtml(currentReviewKpiId, district);
  new bootstrap.Modal(document.getElementById('calcModal')).show();
}

function calcFormHtml(kpiId, district) {
  if (kpiId === 'T1' || kpiId === 'T2' || kpiId === 'T3') {
    return '<label class="form-label">ร้อยละผลการดำเนินงานจริง</label>' +
      '<input type="number" step="0.01" class="form-control" id="calcInput1" placeholder="เช่น 92.5">' +
      '<button class="btn btn-outline-primary btn-sm mt-2" onclick="runCalculator()">คำนวณ</button>';
  }
  if (kpiId === 'P1') {
    var t = BOOT.calcTargets.otop[district];
    var baseText = t ? ('ฐานยอดจำหน่ายปี 2568 ของอำเภอนี้ = ' + t.base.toLocaleString() + ' บาท') : 'ไม่พบข้อมูลฐานของอำเภอนี้';
    return '<p class="small text-muted">' + escapeHtml(baseText) + '</p>' +
      '<label class="form-label">ยอดจำหน่าย OTOP ปีงบประมาณ 2569 (บาท)</label>' +
      '<input type="number" step="0.01" class="form-control" id="calcInput1" placeholder="เช่น 580000000">' +
      '<button class="btn btn-outline-primary btn-sm mt-2" onclick="runCalculator()">คำนวณ</button>';
  }
  if (kpiId === 'P3') {
    var targetV = BOOT.calcTargets.yaSepTid[district] || 0;
    return '<p class="small text-muted">จำนวนหมู่บ้านเป้าหมายของอำเภอนี้ = ' + targetV + ' หมู่บ้าน</p>' +
      '<label class="form-label">จำนวนหมู่บ้านที่จัดกิจกรรมสำเร็จ</label>' +
      '<input type="number" step="1" min="0" class="form-control" id="calcInput1" placeholder="เช่น 1">' +
      '<button class="btn btn-outline-primary btn-sm mt-2" onclick="runCalculator()">คำนวณ</button>';
  }
  if (kpiId === 'P10') {
    var targetP = BOOT.calcTargets.phaThai[district] || 0;
    return '<p class="small text-muted">เป้าหมายจำนวนผ้าที่ส่งประกวดของอำเภอนี้ = ' + targetP + ' ผืน</p>' +
      '<label class="form-label">จำนวนผ้าที่ส่งประกวดจริง</label>' +
      '<input type="number" step="1" min="0" class="form-control" id="calcInput1" placeholder="เช่น 30">' +
      '<button class="btn btn-outline-primary btn-sm mt-2" onclick="runCalculator()">คำนวณ</button>';
  }
  if (kpiId === 'P5') {
    return '<label class="form-label">A: ร้อยละการใช้จ่ายเงินทุนหมุนเวียนที่ได้รับจัดสรร</label>' +
      '<input type="number" step="0.01" class="form-control mb-2" id="calcInputA" placeholder="เช่น 99.2">' +
      '<label class="form-label">B: ร้อยละการรับชำระคืนเงินกู้ยืม</label>' +
      '<input type="number" step="0.01" class="form-control mb-2" id="calcInputB" placeholder="เช่น 60">' +
      '<label class="form-label">C: ร้อยละหนี้เกินกำหนดชำระ</label>' +
      '<input type="number" step="0.01" class="form-control mb-2" id="calcInputC" placeholder="เช่น 4.45">' +
      '<div class="form-check mb-1"><input class="form-check-input" type="checkbox" id="calcMilestone1"><label class="form-check-label small" for="calcMilestone1">ผ่านขั้นตอน 1: ฐานข้อมูลลูกหนี้ครบถ้วน</label></div>' +
      '<div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="calcMilestone2"><label class="form-check-label small" for="calcMilestone2">ผ่านขั้นตอน 2: ปรับปรุงข้อมูลลูกหนี้</label></div>' +
      '<button class="btn btn-outline-primary btn-sm" onclick="runCalculator()">คำนวณ</button>';
  }
  return '<p class="text-muted">ตัวชี้วัดนี้ไม่มีตัวช่วยคำนวณอัตโนมัติ กรุณาประเมินจากหลักฐานเชิงประจักษ์โดยตรง</p>';
}

function bandScore(value, bands, higherIsBetter) {
  if (higherIsBetter) {
    var result = 0;
    for (var i = 0; i < bands.length; i++) { if (value >= bands[i][0]) result = bands[i][1]; }
    return result;
  }
  for (var j = 0; j < bands.length; j++) { if (value <= bands[j][0]) return bands[j][1]; }
  return 0;
}

function round1(n) { return Math.round(n * 10) / 10; }

function readCalcNumber(id) {
  var el = document.getElementById(id);
  if (!el || el.value === '' || el.value === null) return null;
  var n = Number(el.value);
  return isNaN(n) ? null : n;
}

function showCalcMissingFieldsWarning() {
  currentCalcSuggestedScore = null;
  document.getElementById('calcResultText').textContent = 'กรุณากรอกตัวเลขให้ครบทุกช่องก่อนคำนวณ';
}

function runCalculator() {
  var kpiId = currentReviewKpiId;
  var district = currentCalcDistrict;
  var score = 0, detail = '';

  if (kpiId === 'T1' || kpiId === 'T2' || kpiId === 'T3' || kpiId === 'P1' || kpiId === 'P3' || kpiId === 'P10') {
    var v = readCalcNumber('calcInput1');
    if (v === null) { showCalcMissingFieldsWarning(); return; }

    if (kpiId === 'T1') {
      score = bandScore(v, [[80, 1], [85, 2], [90, 3], [95, 4], [100, 5]], true);
      detail = 'ผลการดำเนินงาน ' + v + '%';
    } else if (kpiId === 'T2') {
      score = bandScore(v, [[75, 1], [80, 2], [85, 3], [90, 4], [95, 5]], true);
      detail = 'ผลการดำเนินงาน ' + v + '%';
    } else if (kpiId === 'T3') {
      score = v >= 81 ? bandScore(v, [[81, 2], [86, 3], [91, 4], [96, 5]], true) : 1;
      detail = 'ผลการดำเนินงาน ' + v + '%';
    } else if (kpiId === 'P1') {
      var t = BOOT.calcTargets.otop[district];
      if (!t) { detail = 'ไม่พบข้อมูลฐานของอำเภอนี้'; score = 0; }
      else {
        if (v >= t.l5) score = 5; else if (v >= t.l4) score = 4; else if (v >= t.l3) score = 3;
        else if (v >= t.l2) score = 2; else if (v > t.base) score = 1; else score = 0;
        detail = 'ยอดจำหน่าย ' + v.toLocaleString() + ' บาท (ฐาน ' + t.base.toLocaleString() + ' บาท)';
      }
    } else if (kpiId === 'P3') {
      var target5 = BOOT.calcTargets.yaSepTid[district] || 0;
      var pct5 = target5 ? (v / target5 * 100) : 0;
      score = bandScore(pct5, [[80, 1], [81, 2], [86, 3], [91, 4], [100, 5]], true);
      detail = v + '/' + target5 + ' หมู่บ้าน (' + round1(pct5) + '%)';
    } else if (kpiId === 'P10') {
      var target6 = BOOT.calcTargets.phaThai[district] || 0;
      var pct6 = target6 ? (v / target6 * 100) : 0;
      score = bandScore(pct6, [[60, 1], [70, 2], [80, 3], [90, 4], [100, 5]], true);
      detail = v + '/' + target6 + ' ผืน (' + round1(pct6) + '%)';
    }
  } else if (kpiId === 'P5') {
    var a = readCalcNumber('calcInputA');
    var b = readCalcNumber('calcInputB');
    var c = readCalcNumber('calcInputC');
    if (a === null || b === null || c === null) { showCalcMissingFieldsWarning(); return; }

    var aScore = bandScore(a, [[70, 10], [75, 15], [80, 20], [85, 25], [90, 30], [95, 35], [100, 40]], true);
    var bScore = bandScore(b, [[40, 10], [50, 15], [60, 20], [70, 25], [80, 30]], true);
    var cScore = bandScore(c, [[5, 30], [10, 25], [15, 20], [20, 15], [25, 10]], false);
    var d = aScore + bScore + cScore;
    var m1 = document.getElementById('calcMilestone1').checked;
    var m2 = document.getElementById('calcMilestone2').checked;
    if (m1 && m2 && d >= 90) score = 5;
    else if (m1 && m2 && d >= 80) score = 4;
    else if (m1 && m2 && d >= 70) score = 3;
    else if (m2) score = 2;
    else if (m1) score = 1;
    else score = 0;
    detail = 'A=' + aScore + ' B=' + bScore + ' C=' + cScore + ' รวม D=' + d;
  }

  currentCalcSuggestedScore = score >= 1 ? score : null;
  document.getElementById('calcResultText').textContent = score >= 1
    ? ('คะแนนที่แนะนำ: ระดับ ' + score + ' (' + detail + ')')
    : ('ต่ำกว่าเกณฑ์ระดับ 1 - ' + detail);
}

// ---------- Dashboard ----------

function loadDashboard() {
  if (CURRENT_USER.role === 'Admin') { loadReviewerDashboard(); return; }
  if (CURRENT_USER.role === 'User') { loadDistrictKpiBreakdown(); }
  apiGet('/api/dashboard').then(function (data) {
    renderDashboard(data.summary);
  }).catch(function (err) {
    var cards = document.getElementById('dashboardCards');
    if (cards) cards.innerHTML = '<div class="col-12"><div class="section-card p-4 text-center text-danger">' +
      '<i class="bi bi-exclamation-triangle"></i> เกิดข้อผิดพลาด: ' + escapeHtml(err.message) + '</div></div>';
  });
}

function loadReviewerDashboard() {
  apiGet('/api/dashboard/reviewer').then(function (data) {
    renderReviewerDashboard(data.kpis);
  }).catch(function (err) {
    var cards = document.getElementById('dashboardCards');
    if (cards) cards.innerHTML = '<div class="col-12"><div class="section-card p-4 text-center text-danger">' +
      '<i class="bi bi-exclamation-triangle"></i> เกิดข้อผิดพลาด: ' + escapeHtml(err.message) + '</div></div>';
  });
}

function loadDistrictKpiBreakdown() {
  apiGet('/api/my-evaluation').then(function (data) {
    renderDistrictKpiBreakdown(data.rows);
  }).catch(function (err) {
    var box = document.getElementById('dashboardKpiBreakdown');
    if (box) box.innerHTML = '<div class="section-card p-4 text-center text-danger">' +
      '<i class="bi bi-exclamation-triangle"></i> เกิดข้อผิดพลาด: ' + escapeHtml(err.message) + '</div>';
  });
}

function renderDistrictKpiBreakdown(rows) {
  if (!Array.isArray(rows)) throw new Error('เซิร์ฟเวอร์ส่งค่ากลับมาไม่ถูกต้อง');
  LAST_DISTRICT_KPI_ROWS = rows;
  var teamRows = rows.filter(function (r) { return r.category === 'TEAM'; });
  var indivRows = rows.filter(function (r) { return r.category === 'INDIVIDUAL'; });
  document.getElementById('dashboardKpiBreakdown').innerHTML =
    kpiRadarCardHtml() +
    kpiBreakdownSectionHtml('team', 'bi-people-fill', 'คะแนนรายตัวชี้วัด — ตัวชี้วัดทีม', teamRows) +
    kpiBreakdownSectionHtml('indiv', 'bi-person-fill', 'คะแนนรายตัวชี้วัด — ตัวชี้วัดรายบุคคล', indivRows);
  renderKpiRadarChart(rows);
}

function kpiRadarCardHtml() {
  return '<div class="section-card mb-3">' +
    '<div class="section-card-header"><i class="bi bi-bullseye"></i> ภาพรวมคะแนนรายตัวชี้วัด (กราฟใยแมงมุม)</div>' +
    '<div class="p-3"><div class="row g-4 align-items-center">' +
    '<div class="col-lg-6">' +
    '<div class="radar-chart-wrap"><canvas id="kpiRadarChart"></canvas></div>' +
    '<div class="radar-legend">' +
    '<span class="radar-legend-pill c5"><i class="radar-dot" style="background:#0f6e56"></i>5 ดีมาก</span>' +
    '<span class="radar-legend-pill c4"><i class="radar-dot" style="background:#4fb8a0"></i>4 ดี</span>' +
    '<span class="radar-legend-pill c3"><i class="radar-dot" style="background:#c9972c"></i>3 ปานกลาง</span>' +
    '<span class="radar-legend-pill c1"><i class="radar-dot" style="background:#c8322d"></i>1-2 ควรปรับปรุง</span>' +
    '<span class="radar-legend-pill cx"><i class="radar-dot" style="background:#c7cbd6"></i>ยังไม่ตรวจ</span>' +
    '</div>' +
    '</div>' +
    '<div class="col-lg-6" id="kpiRadarAnalysis"></div>' +
    '</div></div></div>';
}

function formatKpiShortLabel(id) {
  var mp = /^P(\d+)$/.exec(id || '');
  if (mp) return 'บุคคล ' + mp[1];
  var mt = /^T(\d+)$/.exec(id || '');
  if (mt) return 'ทีม ' + mt[1];
  return id;
}

function radarPointColor(score) {
  var n = Number(score);
  if (!score) return '#c7cbd6';
  if (n >= 5) return '#0f6e56';
  if (n === 4) return '#4fb8a0';
  if (n === 3) return '#c9972c';
  return '#c8322d';
}

function renderKpiRadarChart(rows) {
  var canvas = document.getElementById('kpiRadarChart');
  if (!canvas) return;
  if (kpiRadarChartInstance) kpiRadarChartInstance.destroy();
  var labels = rows.map(function (r) { return formatKpiShortLabel(r.kpiId); });
  var scores = rows.map(function (r) { return Number(r.score) || 0; });
  var provinceAvgScores = rows.map(function (r) { return Number(r.provinceAvgScore) || 0; });
  var hasProvinceAvg = provinceAvgScores.some(function (v) { return v > 0; });
  var pointColors = rows.map(function (r) { return radarPointColor(r.score); });
  var pointRadii = rows.map(function (r) { return Number(r.score) >= 1 ? 5 : 3; });
  var datasets = [{
    label: 'คะแนนอำเภอนี้ (เต็ม 5)',
    data: scores,
    backgroundColor: 'rgba(15,110,86,.15)',
    borderColor: '#0f6e56',
    borderWidth: 2,
    pointBackgroundColor: pointColors,
    pointBorderColor: '#fff',
    pointBorderWidth: 1.5,
    pointRadius: pointRadii,
    pointHoverRadius: 7
  }];
  if (hasProvinceAvg) {
    datasets.push({
      label: 'ค่าเฉลี่ยทั้งจังหวัด',
      data: provinceAvgScores,
      backgroundColor: 'rgba(0,0,0,0)',
      borderColor: '#c9972c',
      borderWidth: 2,
      borderDash: [5, 4],
      pointBackgroundColor: '#c9972c',
      pointBorderColor: '#fff',
      pointBorderWidth: 1,
      pointRadius: 3,
      pointHoverRadius: 6
    });
  }
  kpiRadarChartInstance = new Chart(canvas, {
    type: 'radar',
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { r: { min: 0, max: 5, ticks: { stepSize: 1, font: { size: 9 } }, pointLabels: { font: { size: 9 } } } },
      plugins: {
        legend: { display: hasProvinceAvg, position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              var r = rows[ctx.dataIndex];
              if (ctx.datasetIndex === 1) return 'ค่าเฉลี่ยทั้งจังหวัด: ' + ctx.raw + '/5';
              return 'อำเภอนี้: ' + (r.score ? (r.score + '/5') : r.status);
            }
          }
        }
      }
    }
  });
  document.getElementById('kpiRadarAnalysis').innerHTML = kpiAnalysisHtml(rows);
}

function kpiAnalysisHint(r, mode) {
  if (mode === 'score') {
    var parts = [];
    var n = Number(r.score);
    var nextLevel = (r.levels && r.levels[n]) ? r.levels[n] : '';
    if (nextLevel) parts.push('<i class="bi bi-arrow-up-right-circle"></i> เป้าหมายระดับ ' + (n + 1) + ': ' + escapeHtml(nextLevel));
    if (r.aiRecommendations && r.aiRecommendations.length) {
      parts.push('<i class="bi bi-lightbulb text-warning"></i> AI แนะนำ: ' + escapeHtml(r.aiRecommendations[0]));
    }
    return parts.join('<br>');
  }
  if (mode === 'status') {
    if (r.status === 'ยังไม่ส่ง') return '<i class="bi bi-cloud-upload"></i> ยังไม่ได้ส่งหลักฐาน ควรรีบอัปโหลดหลักฐานเชิงประจักษ์';
    if (r.status === 'รอตรวจ') return '<i class="bi bi-hourglass-split"></i> ส่งหลักฐานแล้ว รอนักวิชาการตรวจ' + (r.contact ? ' (ผู้ประสานงาน: ' + escapeHtml(r.contact) + ')' : '');
    return '';
  }
  return '';
}

function kpiAnalysisListHtml(items, emptyText, mode) {
  if (!items.length) return '<div class="text-muted small">' + escapeHtml(emptyText) + '</div>';
  var shown = items.slice(0, 6);
  var extra = items.length - shown.length;
  return '<ul class="kpi-analysis-list mb-0">' + shown.map(function (r) {
    var suffix = mode === 'score' ? ' <span class="text-muted small">(' + r.score + '/5)</span>' : ' ' + statusBadgeHtml(r.status);
    var hint = kpiAnalysisHint(r, mode);
    return '<li>' + escapeHtml(r.kpiName) + suffix + (hint ? '<div class="kpi-analysis-hint">' + hint + '</div>' : '') + '</li>';
  }).join('') + '</ul>' + (extra > 0 ? '<div class="text-muted small mt-1">และอีก ' + extra + ' ตัวชี้วัด</div>' : '');
}

function kpiAnalysisCardHtml(variant, icon, title, items, emptyText, mode) {
  return '<div class="kpi-analysis-card ' + variant + '">' +
    '<div class="kpi-analysis-card-title"><span><i class="bi ' + icon + '"></i> ' + escapeHtml(title) + '</span>' +
    (items.length ? '<span class="kpi-analysis-count">' + items.length + '</span>' : '') +
    '</div>' +
    kpiAnalysisListHtml(items, emptyText, mode) +
    '</div>';
}

function kpiAnalysisHtml(rows) {
  var scored = rows.filter(function (r) { return Number(r.score) >= 1; });
  var strengths = scored.filter(function (r) { return Number(r.score) === 5; });
  var weakest = scored.filter(function (r) { return Number(r.score) <= 3; })
    .sort(function (a, b) { return Number(a.score) - Number(b.score); });
  var pending = rows.filter(function (r) { return !(Number(r.score) >= 1); });
  return kpiAnalysisCardHtml('strength', 'bi-check-circle-fill', 'จุดแข็ง (ได้คะแนนเต็ม)', strengths, 'ยังไม่มีตัวชี้วัดที่ได้คะแนนเต็มในรอบนี้', 'score') +
    kpiAnalysisCardHtml('weak', 'bi-exclamation-triangle-fill', 'จุดที่ควรพัฒนา (คะแนนต่ำสุด)', weakest, 'ไม่มีตัวชี้วัดที่คะแนนต่ำ ทำได้ดีทุกตัว', 'score') +
    kpiAnalysisCardHtml('pending', 'bi-hourglass-split', 'ยังไม่มีผลประเมิน', pending, 'ตรวจครบทุกตัวชี้วัดแล้ว', 'status');
}

function kpiBreakdownSectionHtml(variant, icon, title, rows) {
  var reviewedCount = rows.filter(function (r) { return r.status === 'ตรวจแล้ว'; }).length;
  var historyTh = CURRENT_USER.role === 'SuperAdmin' ? '<th></th>' : '';
  return '<div class="section-card p-3 mb-3">' +
    '<div class="d-flex justify-content-between align-items-center mb-3">' +
    '<h6 class="mb-0"><span class="kpi-section-icon ' + variant + '"><i class="bi ' + icon + '"></i></span>' + escapeHtml(title) + '</h6>' +
    '<span class="badge bg-light text-dark border">ตรวจแล้ว ' + reviewedCount + '/' + rows.length + '</span>' +
    '</div>' +
    '<div class="table-responsive"><table class="table table-sm table-hover mb-0">' +
    '<thead><tr><th>ตัวชี้วัด</th><th>น้ำหนัก</th><th>สถานะ</th><th>คะแนน</th>' + historyTh + '</tr></thead>' +
    '<tbody>' + rows.map(dashboardKpiRowHtml).join('') + '</tbody>' +
    '</table></div></div>';
}

function dashboardKpiRowHtml(r) {
  var scoreText = r.score ? (r.score + ' / 5') : '<span class="text-muted">-</span>';
  var scoreCls = 'kpi-score kpi-' + scoreChipClass(r.score);
  var trAttr = r.status === 'รอตรวจ' ? ' class="kpi-row-pending"' : '';
  var historyTd = CURRENT_USER.role === 'SuperAdmin'
    ? '<td><button type="button" class="btn btn-sm btn-outline-secondary" data-action="view-history" data-district="' + escapeAttr(r.district || '') + '" data-kpi-id="' + escapeAttr(r.kpiId) + '" title="ดูประวัติการตรวจ"><i class="bi bi-clock-history"></i></button></td>'
    : '';
  var aiBadge = (r.aiConsistency || (r.aiRecommendations && r.aiRecommendations.length))
    ? ' <button type="button" class="btn btn-sm btn-outline-warning ms-1" data-action="view-ai-insight" data-district="' + escapeAttr(r.district || '') + '" data-kpi-id="' + escapeAttr(r.kpiId) + '" title="ดูคำแนะนำจาก AI"><i class="bi bi-lightbulb"></i> AI</button>'
    : '';
  return '<tr' + trAttr + '>' +
    '<td class="fw-semibold">' + escapeHtml(r.kpiName) + aiBadge + '</td>' +
    '<td><span class="weight-pill">' + r.weight + '%</span></td>' +
    '<td>' + statusBadgeHtml(r.status) + '</td>' +
    '<td><span class="' + scoreCls + '">' + scoreText + '</span></td>' +
    historyTd +
    '</tr>';
}

function showAiInsight(district, kpiId) {
  var r = (LAST_DISTRICT_KPI_ROWS || []).find(function (x) { return x.district === district && x.kpiId === kpiId; });
  if (!r) return;
  var consistencyBadgeMap = {
    'สอดคล้อง': '<span class="badge bg-success">สอดคล้อง</span>',
    'ไม่แน่ใจ': '<span class="badge bg-warning text-dark">ไม่แน่ใจ</span>',
    'ไม่สอดคล้อง': '<span class="badge bg-danger">ไม่สอดคล้อง</span>'
  };
  var consistencyBadge = consistencyBadgeMap[r.aiConsistency] || escapeHtml(r.aiConsistency || '-');
  var recHtml = (r.aiRecommendations && r.aiRecommendations.length)
    ? '<ul class="mb-0">' + r.aiRecommendations.map(function (x) { return '<li>' + escapeHtml(x) + '</li>'; }).join('') + '</ul>'
    : '<span class="text-muted small">ไม่มีข้อเสนอแนะเพิ่มเติม</span>';
  document.getElementById('aiInsightKpiLabel').textContent = r.kpiName;
  document.getElementById('aiInsightBody').innerHTML =
    '<div class="alert alert-secondary small mb-3"><i class="bi bi-info-circle me-1"></i>ข้อมูลจาก AI เพื่อช่วยชี้เป้าการพัฒนาเบื้องต้นเท่านั้น ไม่ใช่ผลการตัดสินคะแนน</div>' +
    '<div class="mb-2"><strong>ความสอดคล้องกับเกณฑ์ตัวชี้วัด:</strong> ' + consistencyBadge + '</div>' +
    '<div class="mb-0"><strong><i class="bi bi-lightbulb text-warning"></i> ข้อเสนอแนะการพัฒนา/ปรับปรุง:</strong>' + recHtml + '</div>' +
    (r.aiCheckedAt ? '<div class="text-muted small mt-2">ตรวจโดย AI เมื่อ ' + formatDateTimeClient(r.aiCheckedAt) + '</div>' : '');
  new bootstrap.Modal(document.getElementById('aiInsightModal')).show();
}

async function openScoreHistory(district, kpiId) {
  document.getElementById('scoreHistoryLabel').textContent = 'อำเภอ' + district + ' — ' + formatKpiIdLabel(kpiId);
  document.getElementById('scoreHistoryBody').innerHTML = '<div class="text-center text-muted py-3">กำลังโหลด...</div>';
  new bootstrap.Modal(document.getElementById('scoreHistoryModal')).show();
  try {
    const data = await apiGet('/api/admin/history?district=' + encodeURIComponent(district) + '&kpi_id=' + encodeURIComponent(kpiId));
    var box = document.getElementById('scoreHistoryBody');
    if (!data.history.length) { box.innerHTML = '<div class="text-center text-muted py-3">ยังไม่มีประวัติการตรวจตัวชี้วัดนี้</div>'; return; }
    box.innerHTML = data.history.map(scoreHistoryEntryHtml).join('');
  } catch (err) {
    document.getElementById('scoreHistoryBody').innerHTML = '<div class="text-center text-danger py-3"><i class="bi bi-exclamation-triangle"></i> เกิดข้อผิดพลาด: ' + escapeHtml(err.message) + '</div>';
  }
}

function scoreHistoryEntryHtml(h) {
  var oldPart = h.oldScore ? (h.oldScore + '/5') : (h.oldStatus || 'ยังไม่มี');
  var newPart = h.newScore ? (h.newScore + '/5') : (h.newStatus || '-');
  return '<div class="history-entry">' +
    '<div class="d-flex justify-content-between align-items-center mb-1">' +
    '<span class="fw-semibold">' + escapeHtml(h.username) + '</span>' +
    '<span class="text-muted small">' + formatDateTimeClient(h.timestamp) + '</span>' +
    '</div>' +
    '<div class="mb-1"><span class="badge bg-secondary">' + escapeHtml(h.action) + '</span></div>' +
    '<div class="small">' + escapeHtml(oldPart) + '<span class="history-entry-arrow">&rarr;</span><strong>' + escapeHtml(newPart) + '</strong></div>' +
    (h.newNote ? '<div class="small text-muted mt-1">หมายเหตุ: ' + escapeHtml(h.newNote) + '</div>' : '') +
    '</div>';
}

function formatDateTimeClient(millis) {
  if (!millis) return '-';
  return new Date(millis).toLocaleString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderDashboardHero(opts) {
  var pillsHtml = (opts.pills || []).map(function (p) {
    return '<div class="dash-hero-pill"><i class="bi ' + p.icon + '"></i> ' + escapeHtml(p.text) + '</div>';
  }).join('');
  var scoreHtml = opts.score
    ? '<div class="dash-hero-score"><div class="dash-hero-score-value">' + escapeHtml(opts.score.value) + '</div><div class="dash-hero-score-label">' + escapeHtml(opts.score.label) + '</div></div>'
    : '';
  document.getElementById('dashboardHero').innerHTML =
    '<div class="dash-hero">' +
    '<div>' +
    '<div class="dash-hero-tag"><i class="bi bi-patch-check-fill"></i> ระบบตรวจคำรับรองการปฏิบัติราชการ</div>' +
    '<div class="dash-hero-title">' + escapeHtml(opts.title) + '</div>' +
    '<div class="dash-hero-subtitle">' + escapeHtml(opts.subtitle) + '</div>' +
    '<div class="dash-hero-pills">' + pillsHtml + '</div>' +
    '</div>' +
    '<div class="dash-hero-right">' +
    scoreHtml +
    '<div class="dash-hero-meta">' + escapeHtml(opts.metaLabel || '') + '<strong>' + escapeHtml(opts.metaValue || '') + '</strong></div>' +
    '</div>' +
    '</div>';
}

function finalScore5(overallScore) {
  return (Number(overallScore) / 20).toFixed(2);
}

function statTileHtml(variant, icon, label, value, foot, colClass) {
  var cls = variant === 'a' ? '' : ' stat-tile-' + variant;
  return '<div class="' + (colClass || 'col-sm-6 col-lg-3') + '">' +
    '<div class="stat-tile' + cls + '">' +
    '<div class="stat-tile-icon"><i class="bi ' + icon + '"></i></div>' +
    '<div class="stat-tile-label">' + escapeHtml(label) + '</div>' +
    '<div class="stat-tile-value">' + value + '</div>' +
    '<div class="stat-tile-foot">' + escapeHtml(foot) + '</div>' +
    '</div></div>';
}

function renderDashboard(data) {
  if (data.length === 1) { renderDistrictDashboard(data[0]); }
  else { renderProvinceDashboard(data); }
}

function hideDistrictFilter() {
  var box = document.getElementById('dashboardDistrictFilter');
  box.classList.add('d-none');
  box.innerHTML = '';
}

function renderDistrictDashboard(d) {
  hideDistrictFilter();
  renderDashboardHero({
    title: 'ภาพรวมผลการปฏิบัติงาน อำเภอ' + d.district,
    subtitle: 'คะแนนถ่วงน้ำหนักและความคืบหน้าการส่ง-ตรวจหลักฐานของอำเภอท่าน ในรอบการประเมินนี้',
    pills: [
      { icon: 'bi-collection', text: 'รวม ' + d.totalKpi + ' ตัวชี้วัด' },
      { icon: 'bi-hourglass-split', text: 'รอตรวจ ' + Math.max(0, d.submittedCount - d.reviewedCount) + ' รายการ' },
      { icon: 'bi-check2-circle', text: 'ตรวจแล้ว ' + d.reviewedCount + ' รายการ' }
    ],
    score: { value: finalScore5(d.overallScore), label: 'คะแนนรวม (เต็ม 5.00)' },
    metaLabel: 'อำเภอ',
    metaValue: d.district
  });
  document.getElementById('dashboardCards').innerHTML =
    statTileHtml('a', 'bi-people-fill', 'คะแนนรวมทีม (เต็ม 100)', d.teamScore, 'ถ่วงน้ำหนักจากตัวชี้วัดทีม', 'col-md-4') +
    statTileHtml('d', 'bi-person-check-fill', 'คะแนนรวมบุคคล (เต็ม 100)', d.individualScore, 'ถ่วงน้ำหนักจากตัวชี้วัดรายบุคคล', 'col-md-4') +
    statTileHtml('b', 'bi-award-fill', 'คะแนนรวมถ่วงน้ำหนัก (เต็ม 5.00)', finalScore5(d.overallScore), 'เฉลี่ยทีม 50% + บุคคล 50%', 'col-md-4');
  document.getElementById('dashboardChartCard').classList.add('d-none');
}

function districtCardHtml(d, idx) {
  var variants = ['', ' stat-tile-d', ' stat-tile-b', ' stat-tile-c'];
  var submitPct = d.totalKpi ? Math.round(d.submittedCount / d.totalKpi * 100) : 0;
  var reviewPct = d.totalKpi ? Math.round(d.reviewedCount / d.totalKpi * 100) : 0;
  return '<div class="col-md-6 col-lg-4">' +
    '<div class="stat-tile' + variants[idx % variants.length] + ' h-100">' +
    '<div class="d-flex justify-content-between align-items-start mb-3">' +
    '<h6 class="mb-0">' + escapeHtml(d.district) + '</h6>' +
    '<div class="text-end"><div class="fw-bold" style="font-size:1.35rem;color:var(--accent-gold);line-height:1;">' + finalScore5(d.overallScore) + '</div>' +
    '<div class="text-muted" style="font-size:.68rem;">เต็ม 5.00</div></div>' +
    '</div>' +
    '<div class="d-flex justify-content-between small text-muted mb-1"><span>ส่งหลักฐานแล้ว</span><span>' + d.submittedCount + '/' + d.totalKpi + '</span></div>' +
    '<div class="progress mb-2" style="height:6px;"><div class="progress-bar bg-warning" style="width:' + submitPct + '%"></div></div>' +
    '<div class="d-flex justify-content-between small text-muted mb-1"><span>ตรวจประเมินแล้ว</span><span>' + d.reviewedCount + '/' + d.totalKpi + '</span></div>' +
    '<div class="progress" style="height:6px;"><div class="progress-bar bg-success" style="width:' + reviewPct + '%"></div></div>' +
    '</div></div>';
}

function renderProvinceDashboard(data) {
  PROVINCE_DASHBOARD_DATA = data;
  renderDistrictFilterSelect(data);
  showProvinceOverview(data);
}

function renderDistrictFilterSelect(data) {
  var box = document.getElementById('dashboardDistrictFilter');
  var options = '<option value="">ทั้งหมด (' + data.length + ' อำเภอ)</option>' +
    data.map(function (d) { return '<option value="' + escapeAttr(d.district) + '">' + escapeHtml(d.district) + '</option>'; }).join('');
  box.classList.remove('d-none');
  box.innerHTML =
    '<div class="d-flex flex-wrap justify-content-between align-items-end gap-2">' +
    '<div><label class="form-label small fw-semibold mb-1">มุมมอง</label>' +
    '<select class="form-select" style="max-width:320px" id="dashboardDistrictSelect">' + options + '</select></div>' +
    '<div class="d-flex gap-2">' +
    '<button class="btn btn-sm btn-outline-info" id="provinceAiInsightBtn" type="button"><i class="bi bi-robot"></i> AI สรุปภาพรวมจังหวัด</button>' +
    (CURRENT_USER.role === 'SuperAdmin' ? '<button class="btn btn-sm text-white" style="background:var(--gov-navy)" id="exportPdfBtn" type="button"><i class="bi bi-file-earmark-pdf"></i> ส่งออก PDF (ทั้ง 11 อำเภอ)</button>' : '') +
    '</div>' +
    '</div>';
  document.getElementById('provinceAiInsightBtn').addEventListener('click', loadProvinceAiInsight);
  document.getElementById('dashboardDistrictSelect').addEventListener('change', function (e) {
    if (e.target.value) { showSingleDistrictFocus(e.target.value); }
    else { showProvinceOverview(PROVINCE_DASHBOARD_DATA); }
  });
  var exportBtn = document.getElementById('exportPdfBtn');
  if (exportBtn) exportBtn.addEventListener('click', handleExportPdf);
}

async function handleExportPdf() {
  showLoading(true);
  try {
    const res = await fetch('/api/admin/export-pdf', { credentials: 'same-origin' });
    if (!res.ok) {
      const body = await res.json().catch(function () { return null; });
      throw new Error((body && body.error) || ('HTTP ' + res.status));
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const fileName = match ? match[1] : 'รายงานผลการตรวจคำรับรองฯ.pdf';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showLoading(false);
    showToast('สร้างไฟล์ PDF สำเร็จ', 'success');
  } catch (e) {
    showLoading(false);
    showToast('เกิดข้อผิดพลาดขณะดาวน์โหลดไฟล์: ' + e.message, 'danger');
  }
}

function showProvinceOverview(data) {
  var totalDistricts = data.length;
  var totalReviewed = data.reduce(function (s, d) { return s + d.reviewedCount; }, 0);
  var totalKpiAll = data.reduce(function (s, d) { return s + d.totalKpi; }, 0);
  var avgOverall = data.reduce(function (s, d) { return s + d.overallScore; }, 0) / totalDistricts;
  renderDashboardHero({
    title: 'ภาพรวมทั้งจังหวัด ' + totalDistricts + ' อำเภอ',
    subtitle: 'สรุปคะแนนถ่วงน้ำหนักและความคืบหน้าการตรวจประเมินของทุกอำเภอ ในรอบการประเมินนี้',
    pills: [
      { icon: 'bi-signpost-split', text: totalDistricts + ' อำเภอ' },
      { icon: 'bi-clipboard-data', text: 'ตรวจแล้ว ' + totalReviewed + '/' + totalKpiAll + ' รายการ' }
    ],
    score: { value: finalScore5(avgOverall), label: 'คะแนนรวมเฉลี่ยทั้งจังหวัด (เต็ม 5.00)' },
    metaLabel: 'ผู้ใช้งานปัจจุบัน',
    metaValue: (CURRENT_USER.displayName || CURRENT_USER.username || '')
  });
  document.getElementById('dashboardCards').innerHTML =
    statTileHtml('a', 'bi-signpost-split', 'จำนวนอำเภอ', totalDistricts, 'ในจังหวัดพัทลุง', 'col-md-4') +
    statTileHtml('b', 'bi-award-fill', 'คะแนนถ่วงน้ำหนักเฉลี่ย', finalScore5(avgOverall), 'เฉลี่ยทั้งจังหวัด (เต็ม 5.00)', 'col-md-4') +
    statTileHtml('c', 'bi-clipboard-check-fill', 'ตรวจแล้วรวม', totalReviewed + '/' + totalKpiAll, 'ทุกอำเภอรวมกัน', 'col-md-4') +
    '<div class="col-12"><div class="row g-3 mt-1">' + data.map(districtCardHtml).join('') + '</div></div>';
  renderDashboardChart(data);
  document.getElementById('dashboardKpiBreakdown').innerHTML = '';
}

function showSingleDistrictFocus(district) {
  var summary = (PROVINCE_DASHBOARD_DATA || []).find(function (d) { return d.district === district; });
  document.getElementById('dashboardChartCard').classList.add('d-none');
  document.getElementById('provinceAiInsightCard').classList.add('d-none');
  if (!summary) { return; }
  renderDashboardHero({
    title: 'อำเภอ' + district,
    subtitle: 'รายละเอียดคะแนนรายตัวชี้วัดของอำเภอนี้ ในรอบการประเมินนี้ (มุมมองของผู้ดูแลระบบ)',
    pills: [
      { icon: 'bi-collection', text: 'รวม ' + summary.totalKpi + ' ตัวชี้วัด' },
      { icon: 'bi-check2-circle', text: 'ตรวจแล้ว ' + summary.reviewedCount + ' รายการ' }
    ],
    score: { value: finalScore5(summary.overallScore), label: 'คะแนนรวม (เต็ม 5.00)' },
    metaLabel: 'อำเภอ',
    metaValue: district
  });
  document.getElementById('dashboardCards').innerHTML =
    statTileHtml('a', 'bi-collection', 'จำนวนตัวชี้วัด', summary.totalKpi, 'ตัวชี้วัดทั้งหมดของอำเภอนี้', 'col-md-4') +
    statTileHtml('c', 'bi-check2-circle', 'ตรวจแล้ว', summary.reviewedCount + '/' + summary.totalKpi, 'จำนวนที่ตรวจประเมินแล้ว', 'col-md-4') +
    statTileHtml('b', 'bi-award-fill', 'คะแนนรวมถ่วงน้ำหนัก', finalScore5(summary.overallScore), 'เต็ม 5.00', 'col-md-4');
  loadDistrictDetailForAdmin(district);
}

async function loadDistrictDetailForAdmin(district) {
  document.getElementById('dashboardKpiBreakdown').innerHTML = '<div class="section-card p-4 text-center text-muted">กำลังโหลด...</div>';
  try {
    const data = await apiGet('/api/admin/district-evaluation/' + encodeURIComponent(district));
    renderDistrictKpiBreakdown(data.rows);
  } catch (err) {
    document.getElementById('dashboardKpiBreakdown').innerHTML = '<div class="section-card p-4 text-center text-danger">' +
      '<i class="bi bi-exclamation-triangle"></i> เกิดข้อผิดพลาด: ' + escapeHtml(err.message) + '</div>';
  }
}

var publicScoreChartInstance = null;

// แสดงคะแนนเปรียบเทียบทุกอำเภอที่หน้า Login โดยไม่ต้องเข้าสู่ระบบ
async function loadPublicScoreChart() {
  try {
    const data = await apiGet('/api/public/scores');
    document.getElementById('publicChartLoading').classList.add('d-none');
    var sorted = (data.scores || []).slice().sort(function (a, b) { return b.overallScore - a.overallScore; });
    var labels = sorted.map(function (r) { return r.district; });
    var scores = sorted.map(function (r) { return Number(finalScore5(r.overallScore)); });
    var avg = scores.length ? scores.reduce(function (a, b) { return a + b; }, 0) / scores.length : 0;
    var ctx = document.getElementById('publicScoreChart');
    if (publicScoreChartInstance) publicScoreChartInstance.destroy();
    publicScoreChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'คะแนนรวมถ่วงน้ำหนัก (เต็ม 5.00)',
          data: scores,
          backgroundColor: scores.map(function (s) { return s >= avg ? '#e6c076' : 'rgba(255,255,255,.35)'; }),
          borderRadius: 4,
          maxBarThickness: 22
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { min: 0, max: 5, ticks: { color: 'rgba(255,255,255,.75)', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.12)' } },
          y: { ticks: { color: '#fff', font: { size: 10 } }, grid: { display: false } }
        }
      }
    });
  } catch (e) {
    document.getElementById('publicChartLoading').textContent = 'ไม่สามารถโหลดคะแนนเปรียบเทียบได้ในขณะนี้';
  }
}

function renderDashboardChart(data) {
  var chartCard = document.getElementById('dashboardChartCard');
  if (data.length < 2) { chartCard.classList.add('d-none'); return; }
  chartCard.classList.remove('d-none');
  var ctx = document.getElementById('dashboardChart');
  if (dashboardChartInstance) dashboardChartInstance.destroy();
  dashboardChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(function (d) { return d.district; }),
      datasets: [
        { label: 'คะแนนถ่วงน้ำหนัก (เต็ม 5.00)', data: data.map(function (d) { return Number(finalScore5(d.overallScore)); }), backgroundColor: '#c9972c' }
      ]
    },
    options: { responsive: true, scales: { y: { beginAtZero: true, max: 5 } } }
  });
}

function renderReviewerDashboard(data) {
  hideDistrictFilter();
  document.getElementById('dashboardKpiBreakdown').innerHTML = '';
  var totalAssigned = data.length;
  var totalReviewed = data.reduce(function (s, k) { return s + k.reviewedCount; }, 0);
  var totalCount = data.reduce(function (s, k) { return s + k.totalCount; }, 0);
  var scoredKpis = data.filter(function (k) { return k.avgScore; });
  var overallAvg = scoredKpis.length ? round1(scoredKpis.reduce(function (s, k) { return s + k.avgScore; }, 0) / scoredKpis.length) : 0;

  renderDashboardHero({
    title: 'ภาพรวมงานตรวจของท่าน',
    subtitle: 'ตัวชี้วัดที่ท่านได้รับมอบหมายให้ตรวจให้คะแนน เทียบทั้ง 11 อำเภอ',
    pills: [
      { icon: 'bi-clipboard-data', text: 'รับผิดชอบ ' + totalAssigned + ' ตัวชี้วัด' },
      { icon: 'bi-check2-circle', text: 'ตรวจแล้ว ' + totalReviewed + '/' + totalCount + ' รายการ' }
    ],
    metaLabel: 'นักวิชาการ',
    metaValue: (CURRENT_USER.displayName || CURRENT_USER.username || '')
  });

  if (!data.length) {
    document.getElementById('dashboardCards').innerHTML = '<div class="col-12"><div class="section-card p-4 text-center text-muted">ยังไม่มีตัวชี้วัดที่ท่านได้รับมอบหมายให้ตรวจ</div></div>';
    document.getElementById('dashboardChartCard').classList.add('d-none');
    return;
  }

  var summaryTiles =
    statTileHtml('a', 'bi-clipboard-data', 'ตัวชี้วัดที่รับผิดชอบ', totalAssigned, 'ตัวชี้วัด') +
    statTileHtml('d', 'bi-check2-circle', 'ตรวจแล้ว', totalReviewed + '/' + totalCount, 'ทุกตัวชี้วัดรวมกัน') +
    statTileHtml('b', 'bi-graph-up', 'คะแนนเฉลี่ย (เต็ม 5)', overallAvg || '-', 'เฉพาะรายการที่ตรวจแล้ว');

  var variants = ['', ' stat-tile-d', ' stat-tile-b', ' stat-tile-c'];
  var colClass = data.length === 1 ? 'col-12' : 'col-lg-6';
  var kpiCardsHtml = data.map(function (kpi, idx) {
    var reviewPct = kpi.totalCount ? Math.round(kpi.reviewedCount / kpi.totalCount * 100) : 0;
    var chips = kpi.districts.map(function (d) {
      return '<div class="district-score-chip">' +
        '<div class="district-score-chip-name" title="' + escapeAttr(d.district) + '">' + escapeHtml(d.district) + '</div>' +
        '<div class="district-score-chip-value ' + scoreChipClass(d.score) + '">' + (d.score || '-') + '</div>' +
        statusBadgeHtml(d.status) +
        '</div>';
    }).join('');
    return '<div class="' + colClass + '">' +
      '<div class="stat-tile' + variants[idx % variants.length] + ' h-100">' +
      '<h6 class="mb-1">' + escapeHtml(kpi.kpiName) + '</h6>' +
      '<div class="text-muted small mb-2">' + escapeHtml(kpi.category) + ' &middot; น้ำหนัก ' + kpi.weight + '%</div>' +
      '<div class="d-flex justify-content-between small mb-1"><span>ตรวจแล้ว</span><span>' + kpi.reviewedCount + '/' + kpi.totalCount + '</span></div>' +
      '<div class="progress mb-2" style="height:8px;"><div class="progress-bar bg-success" style="width:' + reviewPct + '%"></div></div>' +
      '<div class="d-flex justify-content-between small mb-2"><span>คะแนนเฉลี่ย (เต็ม 5)</span><strong>' + (kpi.avgScore || '-') + '</strong></div>' +
      '<div class="district-score-grid">' + chips + '</div>' +
      '</div></div>';
  }).join('');

  document.getElementById('dashboardCards').innerHTML = summaryTiles + '<div class="col-12"><div class="row g-3 mt-1">' + kpiCardsHtml + '</div></div>';
  renderReviewerDashboardChart(data);
}

function renderReviewerDashboardChart(data) {
  var chartCard = document.getElementById('dashboardChartCard');
  chartCard.classList.remove('d-none');
  var ctx = document.getElementById('dashboardChart');
  if (dashboardChartInstance) dashboardChartInstance.destroy();
  var palette = ['#0f6e56', '#4fb8a0', '#f4a340', '#c0563a', '#3a6ea5', '#8e5ea2'];
  dashboardChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data[0].districts.map(function (d) { return d.district; }),
      datasets: data.map(function (kpi, idx) {
        return { label: kpi.kpiName, data: kpi.districts.map(function (d) { return Number(d.score) || 0; }), backgroundColor: palette[idx % palette.length] };
      })
    },
    options: { responsive: true, scales: { y: { beginAtZero: true, max: 5 } } }
  });
}

// ---------- Utilities ----------

function formatKpiIdLabel(id) {
  var mp = /^P(\d+)$/.exec(id || '');
  if (mp) return 'ตัวชี้วัดรายบุคคลที่ ' + mp[1];
  var mt = /^T(\d+)$/.exec(id || '');
  if (mt) return 'ตัวชี้วัดรายทีมที่ ' + mt[1];
  return id;
}

function statusBadgeHtml(status) {
  if (status === 'ตรวจแล้ว') return '<span class="badge bg-success">ตรวจแล้ว</span>';
  if (status === 'รอตรวจ') return '<span class="badge bg-warning text-dark">รอตรวจ</span>';
  return '<span class="badge bg-secondary">ยังไม่ส่ง</span>';
}

function scoreChipClass(score) {
  var n = Number(score);
  if (!score) return 'score-empty';
  if (n >= 5) return 'score-5';
  if (n === 4) return 'score-4';
  if (n === 3) return 'score-3';
  return 'score-low';
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str === null || str === undefined ? '' : String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function showLoading(show) {
  document.getElementById('loadingOverlay').classList.toggle('d-none', !show);
}

function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  var el = document.createElement('div');
  el.className = 'toast align-items-center text-bg-' + (type || 'primary') + ' border-0';
  el.setAttribute('role', 'alert');
  el.innerHTML = '<div class="d-flex"><div class="toast-body">' + escapeHtml(message) + '</div>' +
    '<button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>';
  container.appendChild(el);
  var toast = new bootstrap.Toast(el, { delay: 4000 });
  toast.show();
  el.addEventListener('hidden.bs.toast', function () { el.remove(); });
}

function onServerError(err) {
  showLoading(false);
  showToast('เกิดข้อผิดพลาด: ' + err.message, 'danger');
}
