// จัดการไฟล์หลักฐานใน Supabase Storage — bucket แบบ private + signed URL
// แก้ tech debt §7.1 #6 (เดิม bucket เปิด public ใครก็เข้าถึงไฟล์ได้โดยไม่ต้อง login)
const { getSupabase } = require('./supabase');

const BUCKET = process.env.EVIDENCE_BUCKET || 'evidence';
const SIGNED_URL_TTL_SEC = 5 * 60; // 5 นาที

// Supabase Storage key ต้องเป็น ASCII-safe — ชื่ออำเภอเป็นภาษาไทยใช้ตรง ๆ เป็นชื่อโฟลเดอร์ไม่ได้
// (เจอ error "Invalid key" จริงตอนทดสอบ) จึงเข้ารหัสเป็น base64url แทน (ยังคง deterministic ต่ออำเภอเดิม)
function slugifyDistrict(district) {
  return Buffer.from(String(district), 'utf8').toString('base64url');
}

function buildPath(district, kpiId, originalName) {
  const safeName = String(originalName || 'evidence').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${slugifyDistrict(district)}/${kpiId}/${Date.now()}_${safeName}`;
}

// สร้าง "ตั๋วอัปโหลด" ให้ browser ส่งไฟล์ตรงไปที่ Supabase Storage เอง (ไม่ผ่าน Vercel function)
// จำเป็นสำหรับไฟล์ที่ใหญ่กว่าขีดจำกัด request body ของ Vercel (~4.5MB บนแผนฟรี)
async function createUploadTicket(district, kpiId, originalName) {
  const supabase = getSupabase();
  const path = buildPath(district, kpiId, originalName);
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path, signedUrl: data.signedUrl, token: data.token };
}

async function getSignedEvidenceUrl(path) {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SEC);
  if (error) throw error;
  return data.signedUrl;
}

async function deleteEvidenceFile(path) {
  if (!path) return;
  const supabase = getSupabase();
  // ไฟล์อาจถูกลบไปก่อนแล้ว/ไม่มีสิทธิ์เข้าถึง - ไม่ใช่ข้อผิดพลาดร้ายแรง ข้ามได้ (เหมือนต้นฉบับ)
  await supabase.storage.from(BUCKET).remove([path]);
}

module.exports = { createUploadTicket, getSignedEvidenceUrl, deleteEvidenceFile, BUCKET };
