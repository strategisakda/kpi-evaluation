// Express app หลัก — ใช้ร่วมกันทั้งตอนรันในเครื่อง (dev-server.js)
// และตอนรันบน Vercel serverless (api/index.js)
const express = require('express');
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

const app = express();
app.use(express.json());
app.use(express.static('public'));

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
