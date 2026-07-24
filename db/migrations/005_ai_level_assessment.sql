-- =====================================================================
-- Migration 005: ให้ AI ประเมินว่าหลักฐานที่แนบเข้าข่ายเกณฑ์ระดับคะแนนไหน (1-5)
-- ยังคงเป็น advisory เท่านั้น — ไม่ตัดสินคะแนนจริง (นักวิชาการเป็นผู้ตัดสินใจ)
-- =====================================================================
alter table public.evaluation_data
  add column if not exists ai_achieved_level smallint,
  add column if not exists ai_level_reasoning text;
