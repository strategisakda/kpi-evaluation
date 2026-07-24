// จัดการไฟล์หลักฐานใน Supabase Storage — bucket แบบ private + signed URL
// แก้ tech debt §7.1 #6 (เดิม bucket เปิด public ใครก็เข้าถึงไฟล์ได้โดยไม่ต้อง login)
const { getSupabase } = require('./supabase');

const BUCKET = process.env.EVIDENCE_BUCKET || 'evidence';
const SIGNED_URL_TTL_SEC = 5 * 60; // 5 นาที

function buildPath(district, kpiId, originalName) {
  const safeName = String(originalName || 'evidence').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${district}/${kpiId}/${Date.now()}_${safeName}`;
}

async function uploadEvidence(district, kpiId, file) {
  const supabase = getSupabase();
  const path = buildPath(district, kpiId, file.originalname);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw error;
  return { path, mimeType: file.mimetype, fileName: file.originalname };
}

async function getSignedEvidenceUrl(path) {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SEC);
  if (error) throw error;
  return data.signedUrl;
}

module.exports = { uploadEvidence, getSignedEvidenceUrl, BUCKET };
