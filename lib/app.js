// Express app หลัก — ใช้ร่วมกันทั้งตอนรันในเครื่อง (dev-server.js)
// และตอนรันบน Vercel serverless (api/index.js)
const express = require('express');
const multer = require('multer');
const { getSupabase } = require('./supabase');
const {
  verifyPassword,
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
const { uploadEvidence, getSignedEvidenceUrl } = require('./storage');

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
      .select(
        'kpi_id, category, kpi_name, weight, requires_evidence, allow_ai, assigned_reviewer_username, sort_order'
      )
      .order('sort_order', { ascending: true });
    if (error) throw error;
    res.json({ ok: true, kpis: data });
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

    const { data: kpis, error: kpiErr } = await supabase
      .from('kpi_master')
      .select('kpi_id, category, weight');
    if (kpiErr) throw kpiErr;

    const { data: evals, error: evalErr } = await supabase
      .from('evaluation_data')
      .select('district, kpi_id, score, status');
    if (evalErr) throw evalErr;

    const kpiByid = Object.fromEntries(kpis.map((k) => [k.kpi_id, k]));
    const byDistrict = {};

    for (const row of evals) {
      if (row.status !== 'ตรวจแล้ว' || row.score == null) continue;
      const kpi = kpiByid[row.kpi_id];
      if (!kpi) continue;

      if (!byDistrict[row.district]) {
        byDistrict[row.district] = { team: 0, individual: 0 };
      }
      const contribution = (row.score / 5) * Number(kpi.weight);
      if (kpi.category === 'TEAM') {
        byDistrict[row.district].team += contribution;
      } else {
        byDistrict[row.district].individual += contribution;
      }
    }

    const round2 = (n) => Math.round(n * 100) / 100;
    const scores = Object.entries(byDistrict).map(([district, s]) => ({
      district,
      overallScore: round2((s.team + s.individual) / 2),
    }));

    res.json({ ok: true, scores });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = app;
