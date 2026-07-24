-- =====================================================================
-- KPI Evaluation System — Supabase (PostgreSQL) Schema
-- source of truth ของฐานข้อมูล  |  รันไฟล์นี้ใน Supabase > SQL Editor
-- ออกแบบตาม PROJECT_FOUNDATION.md §4 และแก้ tech debt §7 ตั้งแต่ต้น:
--   * password เก็บเป็น bcrypt hash (รวม salt ในตัว → ไม่มีปัญหา salt ซ้ำ §7.1)
--   * session เก็บเป็น token_hash ไม่ใช่ plaintext (§7.1 #7)
--   * เพิ่ม flag allow_ai กัน PII หลุดเข้า AI (§7.4 #19 / §9 #5)
--   * เก็บ path ไฟล์ Supabase Storage (private bucket + signed URL §9 #6)
-- =====================================================================

-- gen_random_uuid() มากับ pgcrypto (Supabase เปิดให้อยู่แล้ว)
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- users  (เดิม: User_Config)
-- ---------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique,
  password_hash text not null,                       -- bcrypt (มี salt ในตัว)
  display_name  text,
  role          text not null check (role in ('User','Admin','SuperAdmin')),
  district      text,                                -- ใช้กับ role = User
  contact_email text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- sessions  (เดิม: Sessions) — เก็บ hash ของ token เท่านั้น
-- ---------------------------------------------------------------------
create table if not exists public.sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists idx_sessions_expires on public.sessions(expires_at);

-- ---------------------------------------------------------------------
-- kpi_master  (เดิม: KPI_Master)
-- ---------------------------------------------------------------------
create table if not exists public.kpi_master (
  kpi_id                     text primary key,
  category                   text not null check (category in ('TEAM','INDIVIDUAL')),
  kpi_name                   text not null,
  weight                     numeric not null default 0,
  note                       text,
  level1                     text,
  level2                     text,
  level3                     text,
  level4                     text,
  level5                     text,
  data_source                text,
  contact                    text,
  requires_evidence          boolean not null default true,
  allow_ai                   boolean not null default true,   -- false = ห้ามส่งเข้า AI (กัน PII)
  assigned_reviewer_username text references public.users(username),
  sort_order                 int not null default 0
);

-- ---------------------------------------------------------------------
-- evaluation_data  (เดิม: Evaluation_Data) — คีย์ธรรมชาติ (district, kpi_id)
-- ---------------------------------------------------------------------
create table if not exists public.evaluation_data (
  id                  uuid primary key default gen_random_uuid(),
  district            text not null,
  kpi_id              text not null references public.kpi_master(kpi_id),
  score               int check (score between 1 and 5),          -- null = ยังไม่ตรวจ
  evidence_link       text,
  evidence_file_name  text,
  evidence_file_path  text,                                       -- path ใน Supabase Storage
  evidence_mime_type  text,
  storage_type        text default 'supabase',
  status              text not null default 'ยังไม่ส่ง'
                        check (status in ('ยังไม่ส่ง','รอตรวจ','ตรวจแล้ว')),
  note                text,
  submitted_at        timestamptz,
  evaluated_at        timestamptz,
  evaluated_by        text,
  ai_consistency      text,        -- สอดคล้อง | ไม่แน่ใจ | ไม่สอดคล้อง
  ai_summary          text,
  ai_observations     jsonb,
  ai_recommendations  jsonb,
  ai_checked_at       timestamptz,
  unique (district, kpi_id)
);
create index if not exists idx_eval_district on public.evaluation_data(district);
create index if not exists idx_eval_kpi      on public.evaluation_data(kpi_id);
create index if not exists idx_eval_status   on public.evaluation_data(status);

-- ---------------------------------------------------------------------
-- history  (เดิม: History) — audit log การเปลี่ยนคะแนน/สถานะ
-- ---------------------------------------------------------------------
create table if not exists public.history (
  id         uuid primary key default gen_random_uuid(),
  ts         timestamptz not null default now(),
  username   text,
  district   text,
  kpi_id     text,
  action     text,
  old_score  int,
  old_status text,
  old_note   text,
  new_score  int,
  new_status text,
  new_note   text
);
create index if not exists idx_history_district on public.history(district);

-- ---------------------------------------------------------------------
-- settings — key/value (รอบประเมิน, ข้อความ popup ฯลฯ)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  key   text primary key,
  value jsonb
);

-- ---------------------------------------------------------------------
-- RLS: เปิดทุกตาราง แต่ไม่มี policy → anon/public key เข้าไม่ได้เลย
-- backend เข้าถึงด้วย service_role key (bypass RLS) เท่านั้น
-- ---------------------------------------------------------------------
alter table public.users           enable row level security;
alter table public.sessions        enable row level security;
alter table public.kpi_master      enable row level security;
alter table public.evaluation_data enable row level security;
alter table public.history         enable row level security;
alter table public.settings        enable row level security;
