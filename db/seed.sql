-- =====================================================================
-- Seed ข้อมูลเดโม (ใช้พิสูจน์ว่าท่อ Vercel↔Supabase ทำงาน)
-- ⚠️ ชื่อ KPI / ระดับ 1-5 / ชื่ออำเภอ เป็น PLACEHOLDER
--    ต้องแทนที่ด้วยข้อมูลจริงจากระบบเดิม (14 KPI: T1-T4, P1-P10)
-- รันหลัง schema.sql
-- =====================================================================

-- รอบประเมิน (ใช้ทำ popup / หัวรายงาน)
insert into public.settings (key, value) values
  ('round', '{"label":"รอบประเมิน 2568","active":true}')
on conflict (key) do update set value = excluded.value;

-- KPI ตัวอย่าง (แทนที่ด้วยชุดจริง 14 ตัว + น้ำหนักจริงภายหลัง)
insert into public.kpi_master (kpi_id, category, kpi_name, weight, requires_evidence, allow_ai, sort_order) values
  ('T1', 'TEAM',       '[ตัวอย่าง] KPI ทีม 1', 40, true,  true,  1),
  ('T2', 'TEAM',       '[ตัวอย่าง] KPI ทีม 2', 40, true,  true,  2),
  ('T3', 'TEAM',       '[ตัวอย่าง] KPI ทีม 3', 10, false, true,  3),
  ('T4', 'TEAM',       '[ตัวอย่าง] KPI ทีม 4', 10, false, true,  4),
  ('P1', 'INDIVIDUAL', '[ตัวอย่าง] KPI บุคคล 1', 25, true,  false, 5),
  ('P2', 'INDIVIDUAL', '[ตัวอย่าง] KPI บุคคล 2', 25, true,  true,  6),
  ('P3', 'INDIVIDUAL', '[ตัวอย่าง] KPI บุคคล 3', 25, true,  true,  7),
  ('P4', 'INDIVIDUAL', '[ตัวอย่าง] KPI บุคคล 4', 25, false, true,  8)
on conflict (kpi_id) do nothing;

-- คะแนนตัวอย่าง 3 อำเภอ (ให้ /api/public/scores มีข้อมูลโชว์)
insert into public.evaluation_data (district, kpi_id, score, status, evaluated_at, evaluated_by) values
  ('อำเภอ A', 'T1', 5, 'ตรวจแล้ว', now(), 'seed'),
  ('อำเภอ A', 'T2', 4, 'ตรวจแล้ว', now(), 'seed'),
  ('อำเภอ A', 'P1', 4, 'ตรวจแล้ว', now(), 'seed'),
  ('อำเภอ A', 'P2', 5, 'ตรวจแล้ว', now(), 'seed'),
  ('อำเภอ B', 'T1', 3, 'ตรวจแล้ว', now(), 'seed'),
  ('อำเภอ B', 'T2', 3, 'ตรวจแล้ว', now(), 'seed'),
  ('อำเภอ B', 'P1', 2, 'ตรวจแล้ว', now(), 'seed'),
  ('อำเภอ C', 'T1', 4, 'ตรวจแล้ว', now(), 'seed'),
  ('อำเภอ C', 'P1', 3, 'ตรวจแล้ว', now(), 'seed')
on conflict (district, kpi_id) do nothing;
