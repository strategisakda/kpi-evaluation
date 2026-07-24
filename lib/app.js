// Express app หลัก — ใช้ร่วมกันทั้งตอนรันในเครื่อง (dev-server.js)
// และตอนรันบน Vercel serverless (api/index.js)
const express = require('express');
const multer = require('multer');
const { getSupabase } = require('./supabase');
const {
  verifyPassword,
  hashPassword,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  checkRateLimit,
  recordLoginAttempt,
  createSession,
  deleteSessionByToken,
  requireAuth,
  SESSION_TTL_MS,
} = require('./auth');
const { uploadEvidence, getSignedEvidenceUrl, BUCKET } = require('./storage');
const { DISTRICTS, CALC_TARGETS } = require('./kpiData');
const {
  getKpiMasterAll,
  getAllEvaluationRows,
  mergeEvalWithKpi,
  computeDistrictSummary,
} = require('./evaluation');
const { analyzeEvidenceWithAI, generateProvinceNarrative } = require('./ai');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB (หมายเหตุ: Vercel Hobby จำกัด request body ~4.5MB อยู่ดี)
});

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ผู้ตรวจ (Admin) แก้คะแนนได้เฉพาะ KPI ที่ตัวเองถูกมอบหมาย, SuperAdmin ทำแทนได้ทุก KPI
async function assertReviewerOwnership(supabase, user, kpiId) {
  if (user.role === 'SuperAdmin') return;
  const { data: kpi, error } = await supabase
    .from('kpi_master')
    .select('assigned_reviewer_username')
    .eq('kpi_id', kpiId)
    .maybeSingle();
  if (error) throw error;
  if (!kpi || kpi.assigned_reviewer_username !== user.username) {
    const e = new Error('คุณไม่มีสิทธิ์ตรวจ KPI นี้ (ไม่ได้รับมอบหมาย)');
    e.statusCode = 403;
    throw e;
  }
}

function toKpiListItem(k) {
  return {
    id: k.kpi_id,
    name: k.kpi_name,
    category: k.category,
    weight: k.weight,
    note: k.note || '',
    levels: [k.level1 || '', k.level2 || '', k.level3 || '', k.level4 || '', k.level5 || ''],
    dataSource: k.data_source || '',
    contact: k.contact || '',
    requiresEvidence: k.requires_evidence,
    allowAi: k.allow_ai,
    assignedReviewerUsername: k.assigned_reviewer_username || '',
  };
}

const KPI_MASTER_SELECT =
  'kpi_id, category, kpi_name, weight, note, level1, level2, level3, level4, level5, data_source, contact, requires_evidence, allow_ai, assigned_reviewer_username, sort_order';

// เมื่อ requiresEvidence เปลี่ยน ต้องปรับสถานะแถวที่ยังไม่มีความคืบหน้าจริงให้สอดคล้อง (ไม่แตะแถวที่มีหลักฐาน/ตรวจแล้ว)
async function reconcileEvaluationStatusForKpi(supabase, kpiId, requiresEvidence) {
  if (!requiresEvidence) {
    await supabase
      .from('evaluation_data')
      .update({ status: 'รอตรวจ' })
      .eq('kpi_id', kpiId)
      .eq('status', 'ยังไม่ส่ง');
  } else {
    await supabase
      .from('evaluation_data')
      .update({ status: 'ยังไม่ส่ง' })
      .eq('kpi_id', kpiId)
      .eq('status', 'รอตรวจ')
      .is('evidence_link', null)
      .is('evidence_file_path', null);
  }
}

// ---------------------------------------------------------------------
// GET /api/health — เช็กว่า service ขึ้นและต่อ Supabase ติดจริง
// ---------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  const result = { ok: true, service: 'kpi-evaluation', supabase: 'unknown' };
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('settings').select('key').limit(1);
    result.supabase = error ? `error: ${error.message}` : 'connected';
    if (error) result.ok = false;
  } catch (err) {
    result.ok = false;
    result.supabase = `error: ${err.message}`;
  }
  res.status(result.ok ? 200 : 500).json(result);
});

// ---------------------------------------------------------------------
// POST /api/auth/login — ตรวจ rate limit + bcrypt + สร้าง session (httpOnly cookie)
// ข้อความ error เดียวกันไม่ว่าจะผิดที่ username หรือ password (กัน enumeration §7.1 #4)
// ---------------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const GENERIC_ERROR = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    }
    const supabase = getSupabase();

    const allowed = await checkRateLimit(supabase, username);
    if (!allowed) {
      return res.status(429).json({
        ok: false,
        error: 'พยายามเข้าสู่ระบบผิดพลาดหลายครั้งเกินไป กรุณาลองใหม่ภายหลัง',
      });
    }

    const { data: user } = await supabase
      .from('users')
      .select('id, username, password_hash, display_name, role, district')
      .eq('username', username)
      .maybeSingle();

    if (!user) {
      await recordLoginAttempt(supabase, username, false);
      return res.status(401).json({ ok: false, error: GENERIC_ERROR });
    }

    const passwordOk = await verifyPassword(password, user.password_hash);
    if (!passwordOk) {
      await recordLoginAttempt(supabase, username, false);
      return res.status(401).json({ ok: false, error: GENERIC_ERROR });
    }

    await recordLoginAttempt(supabase, username, true);
    const { token } = await createSession(supabase, user.id);
    setSessionCookie(res, token, SESSION_TTL_MS);

    res.json({
      ok: true,
      user: {
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        district: user.district,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------
app.post('/api/auth/logout', async (req, res) => {
  try {
    const supabase = getSupabase();
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.session) {
      await deleteSessionByToken(supabase, cookies.session);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/auth/me — เช็ก session ปัจจุบัน
// ---------------------------------------------------------------------
app.get('/api/auth/me', requireAuth(), (req, res) => {
  res.json({
    ok: true,
    user: {
      username: req.user.username,
      displayName: req.user.display_name,
      role: req.user.role,
      district: req.user.district,
    },
  });
});

// ---------------------------------------------------------------------
// GET /api/kpi — รายการ KPI ทั้งหมด (ต้อง login แล้วเท่านั้น)
// ---------------------------------------------------------------------
app.get('/api/kpi', requireAuth(), async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('kpi_master')
      .select(KPI_MASTER_SELECT)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    res.json({ ok: true, kpis: data.map(toKpiListItem) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/bootstrap — ข้อมูลตั้งต้นหลัง login (เดิม: getBootstrapData)
// ---------------------------------------------------------------------
app.get('/api/bootstrap', requireAuth(), async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('kpi_master')
      .select(KPI_MASTER_SELECT)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    res.json({
      ok: true,
      user: {
        username: req.user.username,
        displayName: req.user.display_name,
        role: req.user.role,
        district: req.user.district,
      },
      kpiMaster: data.map(toKpiListItem),
      districts: DISTRICTS,
      calcTargets: CALC_TARGETS,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/public/round-info — popup แจ้งเตือนรอบประเมิน (ไม่ต้อง login)
// (เดิม: getRoundInfo)
// ---------------------------------------------------------------------
app.get('/api/public/round-info', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data } = await supabase.from('settings').select('value').eq('key', 'round').maybeSingle();
    const round = data && data.value;
    if (!round || !round.label || !round.endDate) return res.json({ ok: true, info: null });
    const endDate = new Date(round.endDate + 'T23:59:59');
    const daysLeft = Math.ceil((endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    res.json({ ok: true, info: { label: round.label, endDate: round.endDate, daysLeft } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/kpi-responsible?q=... — ค้นหาผู้รับผิดชอบตัวชี้วัด (เดิม: findKpiResponsible)
// ---------------------------------------------------------------------
app.get('/api/kpi-responsible', requireAuth(), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'กรุณาพิมพ์ชื่อหรือรหัสตัวชี้วัดที่ต้องการค้นหา' });

    const supabase = getSupabase();
    const { data: kpis, error } = await supabase
      .from('kpi_master')
      .select('kpi_id, kpi_name, contact, assigned_reviewer_username')
      .or(`kpi_id.ilike.%${q}%,kpi_name.ilike.%${q}%`)
      .limit(5);
    if (error) throw error;

    const reviewerUsernames = kpis.map((k) => k.assigned_reviewer_username).filter(Boolean);
    let reviewersByUsername = {};
    if (reviewerUsernames.length) {
      const { data: reviewers } = await supabase
        .from('users')
        .select('username, display_name, contact_email')
        .in('username', reviewerUsernames);
      reviewersByUsername = Object.fromEntries((reviewers || []).map((r) => [r.username, r]));
    }

    const matches = kpis.map((k) => {
      const reviewer = reviewersByUsername[k.assigned_reviewer_username];
      return {
        kpiId: k.kpi_id,
        kpiName: k.kpi_name,
        dataSourceContact: k.contact || '',
        reviewerName: reviewer ? reviewer.display_name || reviewer.username : '',
        reviewerContactEmail: reviewer ? reviewer.contact_email || '' : '',
      };
    });
    res.json({ ok: true, matches });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// SuperAdmin: จัดการผู้ใช้งาน (เดิม: listUserAccounts / createUserAccount / regeneratePassword)
// ---------------------------------------------------------------------
app.get('/api/admin/users', requireAuth(['SuperAdmin']), async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('users')
      .select('username, display_name, role, district, contact_email')
      .order('username', { ascending: true });
    if (error) throw error;
    res.json({
      ok: true,
      users: data.map((u) => ({
        username: u.username,
        displayName: u.display_name || '',
        role: u.role,
        district: u.district || '',
        contactEmail: u.contact_email || '',
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/admin/reviewers', requireAuth(['SuperAdmin']), async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('users')
      .select('username, display_name, role')
      .in('role', ['Admin', 'SuperAdmin'])
      .order('username', { ascending: true });
    if (error) throw error;
    res.json({ ok: true, reviewers: data.map((u) => ({ username: u.username, displayName: u.display_name || '' })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/users', requireAuth(['SuperAdmin']), async (req, res) => {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    if (!/^[a-zA-Z0-9_.]{3,30}$/.test(username)) {
      return res
        .status(400)
        .json({ ok: false, error: 'Username ใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข จุด และขีดล่าง (3-30 ตัวอักษร)' });
    }
    const role = body.role;
    if (!['SuperAdmin', 'Admin', 'User'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'บทบาทไม่ถูกต้อง' });
    }
    const district = role === 'User' ? String(body.district || '') : null;
    if (role === 'User' && !DISTRICTS.includes(district)) {
      return res.status(400).json({ ok: false, error: 'กรุณาเลือกอำเภอให้ถูกต้องสำหรับบัญชีระดับอำเภอ' });
    }
    const plainPassword = String(body.password || '');
    if (plainPassword.length < 6) {
      return res.status(400).json({ ok: false, error: 'กรุณาตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร' });
    }

    const supabase = getSupabase();
    const { data: existing } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
    if (existing) return res.status(409).json({ ok: false, error: 'มี Username นี้อยู่แล้ว กรุณาใช้ชื่ออื่น' });

    const passwordHash = await hashPassword(plainPassword);
    const { error } = await supabase.from('users').insert({
      username,
      password_hash: passwordHash,
      display_name: String(body.displayName || ''),
      role,
      district,
      contact_email: String(body.contactEmail || '') || null,
    });
    if (error) throw error;

    res.json({ ok: true, username, password: plainPassword });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/users/:username/reset-password', requireAuth(['SuperAdmin']), async (req, res) => {
  try {
    const { username } = req.params;
    const newPassword = String((req.body || {}).newPassword || '');
    if (newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: 'กรุณาตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร' });
    }
    const supabase = getSupabase();
    const passwordHash = await hashPassword(newPassword);
    const { data, error } = await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('username', username)
      .select('username')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'ไม่พบผู้ใช้งานนี้' });
    res.json({ ok: true, username, password: newPassword });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// เปลี่ยนรหัสผ่านตนเอง — เฉพาะ SuperAdmin (เดิม: changeMyPassword — ข้อจำกัดเดียวกับต้นฉบับ)
// ---------------------------------------------------------------------
app.post('/api/auth/change-password', requireAuth(['SuperAdmin']), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
    }
    const supabase = getSupabase();
    const { data: row } = await supabase
      .from('users')
      .select('password_hash')
      .eq('username', req.user.username)
      .maybeSingle();
    const ok = row && (await verifyPassword(currentPassword || '', row.password_hash));
    if (!ok) return res.status(401).json({ ok: false, error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });

    const passwordHash = await hashPassword(newPassword);
    await supabase.from('users').update({ password_hash: passwordHash }).eq('username', req.user.username);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// SuperAdmin: จัดการตัวชี้วัด (เดิม: getAllKpiSettings / updateKpiSettings)
// ---------------------------------------------------------------------
app.post('/api/admin/kpi-settings/:kpiId', requireAuth(['SuperAdmin']), async (req, res) => {
  try {
    const { kpiId } = req.params;
    const requiresEvidence = !!(req.body || {}).requiresEvidence;
    const assignedReviewerUsername = (req.body || {}).assignedReviewerUsername || null;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('kpi_master')
      .update({ requires_evidence: requiresEvidence, assigned_reviewer_username: assignedReviewerUsername })
      .eq('kpi_id', kpiId)
      .select('kpi_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'ไม่พบตัวชี้วัด: ' + kpiId });

    await reconcileEvaluationStatusForKpi(supabase, kpiId, requiresEvidence);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/admin/history — ประวัติการตรวจ (เดิม: getScoreHistory — SuperAdmin เท่านั้น)
// ---------------------------------------------------------------------
app.get('/api/admin/history', requireAuth(['SuperAdmin']), async (req, res) => {
  try {
    const { district, kpi_id: kpiId } = req.query;
    if (!district || !kpiId) {
      return res.status(400).json({ ok: false, error: 'กรุณาระบุ district และ kpi_id' });
    }
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('history')
      .select('ts, username, action, old_score, old_status, old_note, new_score, new_status, new_note')
      .eq('district', district)
      .eq('kpi_id', kpiId)
      .order('ts', { ascending: false });
    if (error) throw error;
    res.json({
      ok: true,
      history: data.map((h) => ({
        timestamp: new Date(h.ts).getTime(),
        username: h.username,
        action: h.action,
        oldScore: h.old_score,
        oldStatus: h.old_status,
        oldNote: h.old_note,
        newScore: h.new_score,
        newStatus: h.new_status,
        newNote: h.new_note,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/evaluation/list — ดูสถานะการประเมิน กรองตาม role
// (เดิม: getReviewerDashboardData / รายอำเภอเห็นแค่ของตัวเอง §5.5)
// ---------------------------------------------------------------------
app.get('/api/evaluation/list', requireAuth(), async (req, res) => {
  try {
    const supabase = getSupabase();
    let query = supabase
      .from('evaluation_data')
      .select(
        'district, kpi_id, score, status, evidence_link, evidence_file_name, note, submitted_at, evaluated_at, evaluated_by'
      );

    if (req.user.role === 'User') {
      query = query.eq('district', req.user.district);
    } else if (req.user.role === 'Admin') {
      const { data: myKpis, error: kpiErr } = await supabase
        .from('kpi_master')
        .select('kpi_id')
        .eq('assigned_reviewer_username', req.user.username);
      if (kpiErr) throw kpiErr;
      const kpiIds = myKpis.map((k) => k.kpi_id);
      if (kpiIds.length === 0) return res.json({ ok: true, evaluations: [] });
      query = query.in('kpi_id', kpiIds);
    }
    // SuperAdmin เห็นทุกแถว ไม่ต้องกรอง

    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, evaluations: data });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/my-evaluation — ตัวชี้วัดของอำเภอตัวเอง แบบเต็ม (ชื่อ/เกณฑ์/AI/provinceAvg)
// (เดิม: getMyEvaluationData — ใช้ทั้งแท็บส่งผลงาน และกราฟใยแมงมุมในแดชบอร์ด)
// ---------------------------------------------------------------------
app.get('/api/my-evaluation', requireAuth(['User']), async (req, res) => {
  try {
    const supabase = getSupabase();
    const [kpiMaster, allRows] = await Promise.all([getKpiMasterAll(supabase), getAllEvaluationRows(supabase)]);
    res.json({ ok: true, rows: mergeEvalWithKpi(req.user.district, kpiMaster, allRows) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/admin/district-evaluation/:district — เหมือน my-evaluation แต่ SuperAdmin ดูอำเภอใดก็ได้
// (เดิม: getDistrictEvaluationData)
// ---------------------------------------------------------------------
app.get('/api/admin/district-evaluation/:district', requireAuth(['SuperAdmin']), async (req, res) => {
  try {
    const { district } = req.params;
    if (!DISTRICTS.includes(district)) return res.status(404).json({ ok: false, error: 'ไม่พบอำเภอ: ' + district });
    const supabase = getSupabase();
    const [kpiMaster, allRows] = await Promise.all([getKpiMasterAll(supabase), getAllEvaluationRows(supabase)]);
    res.json({ ok: true, rows: mergeEvalWithKpi(district, kpiMaster, allRows) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/my-assigned-kpis — รายการ KPI ที่ Admin คนนี้รับผิดชอบตรวจ (เดิม: getMyAssignedKpis)
// ---------------------------------------------------------------------
app.get('/api/my-assigned-kpis', requireAuth(['Admin']), async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('kpi_master')
      .select('kpi_id, kpi_name, category, weight')
      .eq('assigned_reviewer_username', req.user.username)
      .order('sort_order');
    if (error) throw error;
    res.json({
      ok: true,
      kpis: data.map((k) => ({ id: k.kpi_id, name: k.kpi_name, category: k.category, weight: k.weight })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/review/:kpiId — ตารางให้คะแนนของ KPI หนึ่งตัว เทียบทั้ง 11 อำเภอ (เดิม: getKpiReviewData)
// ---------------------------------------------------------------------
app.get('/api/review/:kpiId', requireAuth(['Admin']), async (req, res) => {
  try {
    const { kpiId } = req.params;
    const supabase = getSupabase();
    const { data: kpi, error: kpiErr } = await supabase
      .from('kpi_master')
      .select(
        'kpi_id, kpi_name, category, weight, note, level1, level2, level3, level4, level5, data_source, contact, requires_evidence, assigned_reviewer_username'
      )
      .eq('kpi_id', kpiId)
      .maybeSingle();
    if (kpiErr) throw kpiErr;
    if (!kpi) return res.status(404).json({ ok: false, error: 'ไม่พบตัวชี้วัด: ' + kpiId });
    if (kpi.assigned_reviewer_username !== req.user.username) {
      return res.status(403).json({ ok: false, error: 'คุณไม่มีสิทธิ์ตรวจตัวชี้วัดนี้ (ไม่ได้รับมอบหมาย)' });
    }

    const { data: rows, error: rowsErr } = await supabase.from('evaluation_data').select(
      'district, score, evidence_link, evidence_file_name, status, note, ai_consistency'
    ).eq('kpi_id', kpiId);
    if (rowsErr) throw rowsErr;
    const rowsByDistrict = Object.fromEntries(rows.map((r) => [r.district, r]));

    const districts = DISTRICTS.map((d) => {
      const r = rowsByDistrict[d] || {};
      return {
        district: d,
        score: r.score || '',
        evidenceLink: r.evidence_link || '',
        evidenceFileName: r.evidence_file_name || '',
        status: r.status || 'ยังไม่ส่ง',
        note: r.note || '',
        aiConsistency: r.ai_consistency || '',
      };
    });

    res.json({
      ok: true,
      kpi: {
        id: kpi.kpi_id,
        name: kpi.kpi_name,
        category: kpi.category,
        weight: kpi.weight,
        note: kpi.note || '',
        levels: [kpi.level1 || '', kpi.level2 || '', kpi.level3 || '', kpi.level4 || '', kpi.level5 || ''],
        dataSource: kpi.data_source || '',
        contact: kpi.contact || '',
        requiresEvidence: kpi.requires_evidence,
      },
      districts,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/dashboard — สรุปคะแนนถ่วงน้ำหนัก (เดิม: getDashboardData)
// User เห็นแค่อำเภอตัวเอง, Admin/SuperAdmin เห็นทั้ง 11 อำเภอ
// ---------------------------------------------------------------------
app.get('/api/dashboard', requireAuth(), async (req, res) => {
  try {
    const supabase = getSupabase();
    const [kpiMaster, allRows] = await Promise.all([getKpiMasterAll(supabase), getAllEvaluationRows(supabase)]);
    const scopeDistricts = req.user.role === 'User' ? [req.user.district] : DISTRICTS;
    res.json({ ok: true, summary: scopeDistricts.map((d) => computeDistrictSummary(d, kpiMaster, allRows)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/dashboard/reviewer — ภาพรวมงานตรวจของ Admin คนนี้ (เดิม: getReviewerDashboardData)
// ---------------------------------------------------------------------
app.get('/api/dashboard/reviewer', requireAuth(['Admin']), async (req, res) => {
  try {
    const supabase = getSupabase();
    const [kpiMaster, allRows] = await Promise.all([getKpiMasterAll(supabase), getAllEvaluationRows(supabase)]);
    const myKpis = kpiMaster.filter((k) => k.assigned_reviewer_username === req.user.username);

    const result = myKpis.map((kpi) => {
      const districtRows = DISTRICTS.map((d) => {
        const r = allRows.find((x) => x.district === d && x.kpi_id === kpi.kpi_id) || {};
        return { district: d, score: r.score || '', status: r.status || 'ยังไม่ส่ง' };
      });
      const reviewedCount = districtRows.filter((r) => r.status === 'ตรวจแล้ว').length;
      const scores = districtRows.filter((r) => Number(r.score) >= 1).map((r) => Number(r.score));
      const avgScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : 0;
      return {
        kpiId: kpi.kpi_id,
        kpiName: kpi.kpi_name,
        category: kpi.category,
        weight: kpi.weight,
        districts: districtRows,
        reviewedCount,
        totalCount: districtRows.length,
        avgScore,
      };
    });
    res.json({ ok: true, kpis: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/evidence/submit — อำเภอส่งหลักฐาน (ไฟล์ multipart หรือ evidence_link)
// (เดิม: uploadEvidenceFile ใน Code.gs §5.1 A)
// ---------------------------------------------------------------------
app.post(
  '/api/evidence/submit',
  requireAuth(['User']),
  upload.single('file'),
  async (req, res) => {
    try {
      const supabase = getSupabase();
      const kpiId = req.body.kpi_id;
      const evidenceLink = req.body.evidence_link || null;
      const note = req.body.note || null;
      const district = req.user.district;

      if (!kpiId) {
        return res.status(400).json({ ok: false, error: 'กรุณาระบุ kpi_id' });
      }
      if (!req.file && !evidenceLink) {
        return res.status(400).json({ ok: false, error: 'กรุณาแนบไฟล์หรือระบุลิงก์หลักฐาน' });
      }

      const { data: kpi, error: kpiErr } = await supabase
        .from('kpi_master')
        .select('kpi_id')
        .eq('kpi_id', kpiId)
        .maybeSingle();
      if (kpiErr) throw kpiErr;
      if (!kpi) return res.status(404).json({ ok: false, error: 'ไม่พบ KPI นี้' });

      const payload = {
        district,
        kpi_id: kpiId,
        status: 'รอตรวจ',
        submitted_at: new Date().toISOString(),
        note,
        evidence_link: evidenceLink,
      };

      if (req.file) {
        const uploaded = await uploadEvidence(district, kpiId, req.file);
        payload.evidence_file_path = uploaded.path;
        payload.evidence_file_name = uploaded.fileName;
        payload.evidence_mime_type = uploaded.mimeType;
        payload.storage_type = 'supabase';
      }

      const { data, error } = await supabase
        .from('evaluation_data')
        .upsert(payload, { onConflict: 'district,kpi_id' })
        .select()
        .single();
      if (error) throw error;

      res.json({ ok: true, evaluation: data });
    } catch (err) {
      res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/evidence/url — ขอ signed URL ดูไฟล์หลักฐาน (private bucket, อายุ 5 นาที)
// แก้ tech debt §7.1 #6 (เดิม bucket public ใครก็เปิดได้)
// ---------------------------------------------------------------------
app.get('/api/evidence/url', requireAuth(), async (req, res) => {
  try {
    const { district, kpi_id: kpiId } = req.query;
    if (!district || !kpiId) {
      return res.status(400).json({ ok: false, error: 'กรุณาระบุ district และ kpi_id' });
    }

    const supabase = getSupabase();

    if (req.user.role === 'User' && district !== req.user.district) {
      return res.status(403).json({ ok: false, error: 'ดูได้เฉพาะอำเภอของตัวเอง' });
    }
    if (req.user.role === 'Admin') {
      await assertReviewerOwnership(supabase, req.user, kpiId);
    }

    const { data: row, error } = await supabase
      .from('evaluation_data')
      .select('evidence_file_path')
      .eq('district', district)
      .eq('kpi_id', kpiId)
      .maybeSingle();
    if (error) throw error;
    if (!row || !row.evidence_file_path) {
      return res.status(404).json({ ok: false, error: 'ไม่พบไฟล์หลักฐาน' });
    }

    const url = await getSignedEvidenceUrl(row.evidence_file_path);
    res.json({ ok: true, url });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/evaluation/score — ผู้ตรวจให้คะแนน 1-5 (ownership + history log)
// (เดิม: submitEvaluationScore ใน Code.gs §5.1 B)
// ---------------------------------------------------------------------
app.post('/api/evaluation/score', requireAuth(['Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const { district, kpi_id: kpiId, score, note } = req.body || {};
    if (!district || !kpiId) {
      return res.status(400).json({ ok: false, error: 'กรุณาระบุ district และ kpi_id' });
    }
    const scoreNum = Number(score);
    if (!Number.isInteger(scoreNum) || scoreNum < 1 || scoreNum > 5) {
      return res.status(400).json({ ok: false, error: 'คะแนนต้องเป็นจำนวนเต็ม 1-5' });
    }

    const supabase = getSupabase();
    await assertReviewerOwnership(supabase, req.user, kpiId);

    const { data: existing } = await supabase
      .from('evaluation_data')
      .select('score, status, note')
      .eq('district', district)
      .eq('kpi_id', kpiId)
      .maybeSingle();

    const action = existing && existing.status === 'ตรวจแล้ว' ? 'เปลี่ยนคะแนน' : 'ให้คะแนน';
    const finalNote = note !== undefined ? note : existing ? existing.note : null;

    const { data: updated, error } = await supabase
      .from('evaluation_data')
      .upsert(
        {
          district,
          kpi_id: kpiId,
          score: scoreNum,
          status: 'ตรวจแล้ว',
          evaluated_at: new Date().toISOString(),
          evaluated_by: req.user.username,
          note: finalNote,
        },
        { onConflict: 'district,kpi_id' }
      )
      .select()
      .single();
    if (error) throw error;

    await supabase.from('history').insert({
      username: req.user.username,
      district,
      kpi_id: kpiId,
      action,
      old_score: existing ? existing.score : null,
      old_status: existing ? existing.status : null,
      old_note: existing ? existing.note : null,
      new_score: scoreNum,
      new_status: 'ตรวจแล้ว',
      new_note: finalNote,
    });

    res.json({ ok: true, evaluation: updated });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/evaluation/undo — ยกเลิกการตรวจ คืนสถานะ รอตรวจ/ยังไม่ส่ง
// (เดิม: undoEvaluationScore ใน Code.gs §5.1 B.5)
// ---------------------------------------------------------------------
app.post('/api/evaluation/undo', requireAuth(['Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const { district, kpi_id: kpiId } = req.body || {};
    if (!district || !kpiId) {
      return res.status(400).json({ ok: false, error: 'กรุณาระบุ district และ kpi_id' });
    }

    const supabase = getSupabase();
    await assertReviewerOwnership(supabase, req.user, kpiId);

    const { data: existing, error: fetchErr } = await supabase
      .from('evaluation_data')
      .select('score, status, note, evidence_link, evidence_file_path')
      .eq('district', district)
      .eq('kpi_id', kpiId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing || existing.status !== 'ตรวจแล้ว') {
      return res.status(400).json({ ok: false, error: 'ยังไม่มีการตรวจให้ยกเลิก' });
    }

    const hasEvidence = !!(existing.evidence_link || existing.evidence_file_path);
    const newStatus = hasEvidence ? 'รอตรวจ' : 'ยังไม่ส่ง';

    const { data: updated, error } = await supabase
      .from('evaluation_data')
      .update({ score: null, status: newStatus, evaluated_at: null, evaluated_by: null })
      .eq('district', district)
      .eq('kpi_id', kpiId)
      .select()
      .single();
    if (error) throw error;

    await supabase.from('history').insert({
      username: req.user.username,
      district,
      kpi_id: kpiId,
      action: 'ยกเลิกการตรวจ',
      old_score: existing.score,
      old_status: existing.status,
      old_note: existing.note,
      new_score: null,
      new_status: newStatus,
      new_note: existing.note,
    });

    res.json({ ok: true, evaluation: updated });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/public/scores — คะแนนรวมรายอำเภอ ไม่ต้อง login
// (เดิม: getPublicDistrictScores ใน Code.gs §5.5)
// สูตร §5.2: contribution = (score/5)*weight, overall = (team+individual)/2
// ---------------------------------------------------------------------
app.get('/api/public/scores', async (req, res) => {
  try {
    const supabase = getSupabase();
    const [kpiMaster, allRows] = await Promise.all([getKpiMasterAll(supabase), getAllEvaluationRows(supabase)]);
    const scores = DISTRICTS.map((d) => {
      const summary = computeDistrictSummary(d, kpiMaster, allRows);
      return { district: d, overallScore: summary.overallScore };
    });
    res.json({ ok: true, scores });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/ai/analyze-evidence — AI ช่วยตรวจหลักฐานเบื้องต้น (advisory เท่านั้น)
// (เดิม: analyzeEvidenceWithAI — Admin ตรวจของที่ตนรับผิดชอบ, User ตรวจของอำเภอตนเองก่อนส่งจริง)
// ---------------------------------------------------------------------
app.post('/api/ai/analyze-evidence', requireAuth(['Admin', 'User']), async (req, res) => {
  try {
    const { district, kpi_id: kpiId } = req.body || {};
    if (!district || !kpiId) {
      return res.status(400).json({ ok: false, error: 'กรุณาระบุ district และ kpi_id' });
    }
    if (req.user.role === 'User' && district !== req.user.district) {
      return res.status(403).json({ ok: false, error: 'อำเภอตรวจสอบได้เฉพาะหลักฐานของอำเภอตนเองเท่านั้น' });
    }

    const supabase = getSupabase();
    if (req.user.role === 'Admin') await assertReviewerOwnership(supabase, req.user, kpiId);

    const { data: kpi, error: kpiErr } = await supabase
      .from('kpi_master')
      .select('kpi_name, note, level1, level2, level3, level4, level5, allow_ai')
      .eq('kpi_id', kpiId)
      .maybeSingle();
    if (kpiErr) throw kpiErr;
    if (!kpi) return res.status(404).json({ ok: false, error: 'ไม่พบตัวชี้วัด: ' + kpiId });
    if (!kpi.allow_ai) {
      return res.status(400).json({ ok: false, error: 'ตัวชี้วัดนี้ปิดการใช้งาน AI ไว้ (อาจมีข้อมูลอ่อนไหว)' });
    }

    const { data: row, error: rowErr } = await supabase
      .from('evaluation_data')
      .select('evidence_file_path, evidence_mime_type, evidence_file_name')
      .eq('district', district)
      .eq('kpi_id', kpiId)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row || !row.evidence_file_path) {
      return res.status(400).json({ ok: false, error: 'อำเภอนี้ยังไม่มีไฟล์หลักฐานแนบสำหรับตัวชี้วัดนี้' });
    }

    const result = await analyzeEvidenceWithAI(supabase, BUCKET, {
      district,
      kpiName: kpi.kpi_name,
      kpiNote: kpi.note,
      kpiLevels: [kpi.level1 || '', kpi.level2 || '', kpi.level3 || '', kpi.level4 || '', kpi.level5 || ''],
      evidenceFilePath: row.evidence_file_path,
      evidenceMimeType: row.evidence_mime_type,
    });

    await supabase
      .from('evaluation_data')
      .update({
        ai_consistency: result.consistency,
        ai_summary: result.summary,
        ai_observations: result.observations,
        ai_recommendations: result.recommendations,
        ai_checked_at: new Date().toISOString(),
      })
      .eq('district', district)
      .eq('kpi_id', kpiId);

    res.json({ ok: true, ...result, fileName: row.evidence_file_name });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/ai/province-narrative — AI สรุปจุดแข็ง/จุดอ่อน/ควรโฟกัส ทั้งจังหวัด (SuperAdmin)
// (เดิม: generateProvinceKpiNarrative — สรุปจากคะแนนที่มีอยู่แล้วเท่านั้น ไม่ตัดสินคะแนนใหม่)
// ---------------------------------------------------------------------
app.post('/api/ai/province-narrative', requireAuth(['SuperAdmin']), async (req, res) => {
  try {
    const supabase = getSupabase();
    const [kpiMaster, allRows] = await Promise.all([getKpiMasterAll(supabase), getAllEvaluationRows(supabase)]);

    const summaryRows = kpiMaster.map((kpi) => {
      const districtRows = DISTRICTS.map((d) => {
        const r = allRows.find((x) => x.district === d && x.kpi_id === kpi.kpi_id) || {};
        return { district: d, score: r.score || '' };
      });
      const scores = districtRows.filter((r) => Number(r.score) >= 1).map((r) => Number(r.score));
      const avgScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : 0;
      const weakDistricts = districtRows
        .filter((r) => Number(r.score) >= 1 && Number(r.score) <= 3)
        .map((r) => `${r.district} (${r.score})`);
      return {
        kpiName: kpi.kpi_name,
        weight: kpi.weight,
        avgScore,
        reviewedCount: scores.length,
        totalCount: DISTRICTS.length,
        weakDistricts,
      };
    });

    const result = await generateProvinceNarrative(summaryRows);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = app;
