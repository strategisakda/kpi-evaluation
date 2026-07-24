// ฟังก์ชันช่วยคำนวณ/รวมข้อมูลประเมิน ใช้ร่วมกันหลาย endpoint (dashboard, submit tab, review tab)
// พอร์ตมาจาก Code.gs: mergeEvalWithKpi_, computeDistrictSummary_, computeProvinceAvgByKpi_
const { DISTRICTS } = require('./kpiData');
const { getSignedEvidenceUrl } = require('./storage');

const KPI_MASTER_SELECT =
  'kpi_id, category, kpi_name, weight, note, level1, level2, level3, level4, level5, data_source, contact, requires_evidence, allow_ai, assigned_reviewer_username, sort_order';

const EVAL_SELECT =
  'district, kpi_id, score, status, evidence_link, evidence_file_name, evidence_file_path, note, submitted_at, evaluated_at, evaluated_by, ai_consistency, ai_summary, ai_observations, ai_recommendations, ai_checked_at';

async function getKpiMasterAll(supabase) {
  const { data, error } = await supabase.from('kpi_master').select(KPI_MASTER_SELECT).order('sort_order');
  if (error) throw error;
  return data;
}

async function getAllEvaluationRows(supabase) {
  const { data, error } = await supabase.from('evaluation_data').select(EVAL_SELECT);
  if (error) throw error;
  return data;
}

function millis(v) {
  if (!v) return 0;
  const d = new Date(v);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function computeProvinceAvgByKpi(allRows) {
  const sums = {};
  const counts = {};
  allRows.forEach((r) => {
    const score = Number(r.score);
    if (score >= 1 && score <= 5) {
      sums[r.kpi_id] = (sums[r.kpi_id] || 0) + score;
      counts[r.kpi_id] = (counts[r.kpi_id] || 0) + 1;
    }
  });
  const avg = {};
  Object.keys(sums).forEach((id) => {
    avg[id] = Math.round((sums[id] / counts[id]) * 100) / 100;
  });
  return avg;
}

// รวม evaluation_data ของอำเภอหนึ่ง เข้ากับ kpi_master (ชื่อ/น้ำหนัก/เกณฑ์) + ค่าเฉลี่ยทั้งจังหวัดต่อตัวชี้วัด
// สร้าง signed URL ของหลักฐานให้ตรงนี้เลย (ฝังลิงก์ตรงมากับข้อมูล) แทนที่จะให้ frontend เรียก
// window.open() หลัง await ซึ่งเบราว์เซอร์บางตัวบล็อก popup เงียบ ๆ — ลิงก์ธรรมดาคลิกตรง ๆ ไม่มีทางโดนบล็อก
async function mergeEvalWithKpi(district, kpiMaster, allRows) {
  const provinceAvg = computeProvinceAvgByKpi(allRows);
  const rowsByKpi = Object.fromEntries(allRows.filter((r) => r.district === district).map((r) => [r.kpi_id, r]));

  return Promise.all(
    kpiMaster.map(async (k) => {
      const r = rowsByKpi[k.kpi_id] || {};
      let evidenceUrl = '';
      if (r.evidence_file_path) {
        try { evidenceUrl = await getSignedEvidenceUrl(r.evidence_file_path); } catch (e) { evidenceUrl = ''; }
      }
      return {
        district,
        kpiId: k.kpi_id,
        kpiName: k.kpi_name,
        category: k.category,
        weight: k.weight,
        kpiNote: k.note || '',
        levels: [k.level1 || '', k.level2 || '', k.level3 || '', k.level4 || '', k.level5 || ''],
        dataSource: k.data_source || '',
        contact: k.contact || '',
        requiresEvidence: k.requires_evidence !== false,
        score: r.score || '',
        evidenceLink: r.evidence_link || '',
        evidenceFileName: r.evidence_file_name || '',
        evidenceUrl,
        status: r.status || 'ยังไม่ส่ง',
        note: r.note || '',
        submittedAt: millis(r.submitted_at),
        evaluatedAt: millis(r.evaluated_at),
        aiConsistency: r.ai_consistency || '',
        aiSummary: r.ai_summary || '',
        aiObservations: r.ai_observations || [],
        aiRecommendations: r.ai_recommendations || [],
        aiCheckedAt: millis(r.ai_checked_at),
        provinceAvgScore: provinceAvg[k.kpi_id] || 0,
      };
    })
  );
}

// สรุปคะแนนถ่วงน้ำหนักของอำเภอหนึ่ง (สูตร §5.2: contribution=(score/5)*weight, overall=(team+indiv)/2)
function computeDistrictSummary(district, kpiMaster, allRows) {
  const rows = allRows.filter((r) => r.district === district);
  let teamWeighted = 0;
  let indivWeighted = 0;
  let submittedCount = 0;
  let reviewedCount = 0;

  rows.forEach((r) => {
    const kpi = kpiMaster.find((k) => k.kpi_id === r.kpi_id);
    if (!kpi) return;
    if (r.status === 'รอตรวจ' || r.status === 'ตรวจแล้ว') submittedCount++;
    if (r.status === 'ตรวจแล้ว') reviewedCount++;
    const score = Number(r.score);
    if (score >= 1 && score <= 5) {
      const contribution = (score / 5) * Number(kpi.weight);
      if (kpi.category === 'TEAM') teamWeighted += contribution;
      else indivWeighted += contribution;
    }
  });

  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    district,
    teamScore: round2(teamWeighted),
    individualScore: round2(indivWeighted),
    overallScore: round2((teamWeighted + indivWeighted) / 2),
    totalKpi: rows.length,
    submittedCount,
    reviewedCount,
  };
}

module.exports = {
  DISTRICTS,
  KPI_MASTER_SELECT,
  EVAL_SELECT,
  getKpiMasterAll,
  getAllEvaluationRows,
  computeProvinceAvgByKpi,
  mergeEvalWithKpi,
  computeDistrictSummary,
  millis,
};
