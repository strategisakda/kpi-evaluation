-- =====================================================================
-- Migration 002: Auth — rate limiting + ผู้ใช้ทดสอบ (seed users)
-- รันหลัง db/schema.sql และ db/seed.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- login_attempts — ใช้ทำ rate limit กัน brute-force (แก้ tech debt §7.1 #3)
-- ---------------------------------------------------------------------
create table if not exists public.login_attempts (
  id         uuid primary key default gen_random_uuid(),
  username   text not null,
  success    boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_login_attempts_username_time
  on public.login_attempts(username, created_at desc);

alter table public.login_attempts enable row level security;

-- ---------------------------------------------------------------------
-- ผู้ใช้ทดสอบ 3 บทบาท
-- ⚠️⚠️⚠️ รหัสผ่านชั่วคราว "ChangePlease#2568" ทุกบัญชี — เปลี่ยนทันทีก่อนใช้งานจริง
-- ใช้ pgcrypto's crypt()+gen_salt('bf') สร้าง hash แบบ bcrypt ($2a$)
-- ซึ่งตรวจสอบด้วย bcryptjs (Node) ได้ตรงกัน ไม่ต้องพึ่ง Node รันตอน seed
-- ---------------------------------------------------------------------
insert into public.users (username, password_hash, display_name, role, district, contact_email) values
  ('superadmin', crypt('ChangePlease#2568', gen_salt('bf', 10)),
     'ผู้ดูแลระบบสูงสุด', 'SuperAdmin', null, null),
  ('reviewer1', crypt('ChangePlease#2568', gen_salt('bf', 10)),
     'ผู้ตรวจ (ทีม 1)', 'Admin', null, null),
  ('district_a', crypt('ChangePlease#2568', gen_salt('bf', 10)),
     'เจ้าหน้าที่อำเภอ A', 'User', 'อำเภอ A', null)
on conflict (username) do nothing;

-- มอบหมาย KPI ตัวอย่างบางส่วนให้ reviewer1 ตรวจ (ไว้ทดสอบ ownership check)
update public.kpi_master
set assigned_reviewer_username = 'reviewer1'
where kpi_id in ('T1', 'T2', 'P1', 'P2');
