// Express app หลัก — ใช้ร่วมกันทั้งตอนรันในเครื่อง (dev-server.js)
// และตอนรันบน Vercel serverless (api/index.js)
const express = require('express');
const { getSupabase } = require('./supabase');

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
