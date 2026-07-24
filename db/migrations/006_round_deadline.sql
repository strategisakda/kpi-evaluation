-- =====================================================================
-- Migration 006: ตั้งค่ารอบประเมินให้มี endDate จริง เพื่อให้ popup แจ้งเตือน
-- วันครบกำหนด (checkRoundDeadlinePopup ใน public/app.js) แสดงผลได้
-- (ก่อนหน้านี้ settings.round มีแค่ label/active ไม่มี endDate จึง
--  GET /api/public/round-info คืนค่า info: null เสมอ)
-- =====================================================================
insert into public.settings (key, value) values
  ('round', '{"label":"รอบการประเมินที่ 2/2569 (1 เม.ย. - 30 ก.ย. 2569)","endDate":"2026-09-30","active":true}')
on conflict (key) do update set value = excluded.value;
