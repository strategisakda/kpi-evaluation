# KPI Evaluation — GitHub + Vercel + Supabase (Phase 1)

โครงเริ่มต้นของระบบประเมินผล KPI เวอร์ชันใหม่ ออกแบบให้รันบน **Vercel (serverless)**
เก็บข้อมูลใน **Supabase (Postgres + Storage)** และเก็บซอร์สโค้ดบน **GitHub**

สถานะตอนนี้ = **Phase 1: พิสูจน์ท่อ (plumbing)** — มีแค่ health check และคะแนนตัวอย่าง
ยังไม่มี auth / ส่งหลักฐาน / ให้คะแนน / AI (จะทำใน Phase ถัดไป ดู `PROJECT_FOUNDATION.md` roadmap §10)

## โครงสร้างไฟล์

```
api/index.js       entrypoint สำหรับ Vercel (ห่อ Express app)
lib/app.js          Express routes ทั้งหมด (ใช้ร่วมกัน dev + prod)
lib/supabase.js      Supabase client (service_role — ฝั่ง server เท่านั้น)
dev-server.js        รันในเครื่องตอน dev (npm run dev)
public/index.html    หน้าเช็กสถานะเบื้องต้น
db/schema.sql        โครงตาราง Postgres ทั้งหมด (รันใน Supabase SQL Editor)
db/seed.sql          ข้อมูลตัวอย่าง (แทนที่ด้วยข้อมูลจริงภายหลัง)
vercel.json          ตั้งค่า routing ของ Vercel
.env.example          รายการ environment variables ที่ต้องตั้ง
```

## ขั้นตอน setup (ทำครั้งแรก)

### 1) สร้างโปรเจกต์ Supabase
1. ไปที่ https://supabase.com/dashboard → New Project
2. ตั้งชื่อ + รหัสผ่าน DB (เก็บไว้ให้ดี) → รอสร้างเสร็จ (~2 นาที)
3. เข้า **SQL Editor** → วางเนื้อหาไฟล์ `db/schema.sql` ทั้งหมด → กด Run
4. (ถ้าต้องการข้อมูลตัวอย่าง) วางเนื้อหาไฟล์ `db/seed.sql` → กด Run
5. ไปที่ **Project Settings > API** → copy 2 ค่านี้เก็บไว้:
   - `Project URL` → จะใช้เป็น `SUPABASE_URL`
   - `service_role` secret key → จะใช้เป็น `SUPABASE_SERVICE_ROLE_KEY`
   ⚠️ **service_role key ห้ามหลุดไป client/browser หรือ commit ลง git เด็ดขาด** — bypass ทุกการป้องกันของ DB

### 2) สร้าง repo บน GitHub
1. ไปที่ https://github.com/new → ตั้งชื่อ repo (เช่น `kpi-evaluation`) → **อย่าติ๊ก** "Add README" (มีแล้ว)
2. รันคำสั่งด้านล่างจากโฟลเดอร์นี้ (แทน `<URL>` ด้วย URL repo ที่ได้):
   ```bash
   git init
   git add .
   git commit -m "Initial scaffold: Express + Vercel + Supabase"
   git branch -M main
   git remote add origin <URL>
   git push -u origin main
   ```

### 3) เชื่อม Vercel
1. ไปที่ https://vercel.com/new → เลือก "Import Git Repository" → เลือก repo ที่เพิ่ง push
2. Framework preset ปล่อยเป็น "Other" (ไม่ต้องเลือก) — Vercel จะอ่าน `vercel.json` เอง
3. ก่อนกด Deploy ให้ตั้ง **Environment Variables** (ให้ตรงกับ `.env.example`):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. กด Deploy → รอสักครู่ → ได้ URL เช่น `https://kpi-evaluation.vercel.app`

### 4) ตรวจว่าท่อทำงานจริง
เปิด `https://<โปรเจกต์>.vercel.app/api/health` ควรเห็น:
```json
{ "ok": true, "service": "kpi-evaluation", "supabase": "connected" }
```
ถ้าเห็น `"supabase": "error: ..."` แปลว่า env vars ผิดหรือยังไม่ได้รัน schema.sql

เปิดหน้าแรก `https://<โปรเจกต์>.vercel.app/` จะเห็นตาราง "คะแนนรายอำเภอ" (ถ้ารัน seed.sql แล้ว)

## รันในเครื่องเพื่อ dev

```bash
npm install
cp .env.example .env      # แล้วกรอกค่าจริงใน .env
npm run dev                # เปิด http://localhost:3000
```

## ขั้นตอนถัดไป (ยังไม่ทำใน Phase นี้)

ดู `PROJECT_FOUNDATION.md` §9–10 (Improve / Roadmap) — งานที่รอ:
- Auth 3 บทบาท (bcrypt + rate limit + session hash) — schema เตรียมไว้แล้วใน `users`/`sessions`
- CRUD KPI ให้ครบ 14 ตัวจริง (ตอนนี้ seed.sql เป็นแค่ placeholder 8 ตัว)
- ส่งหลักฐาน (Supabase Storage แบบ private + signed URL) → ให้คะแนน 1–5 → บันทึก History
- คำนวณสรุปคะแนนแบบเต็ม (ทีม/บุคคล/ภาพรวม) + endpoint dashboard
- AI advisory (Claude) พร้อม flag `allow_ai` กัน PII ตาม KPI ที่ requires
