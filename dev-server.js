// รันในเครื่องตอน dev: npm run dev
// โหลด .env (ถ้ามี) แล้ว listen พอร์ตปกติ — บน Vercel ไม่ใช้ไฟล์นี้
try {
  require('dotenv').config();
} catch (_) {
  // dotenv เป็น optional — ถ้าไม่ได้ติดตั้งก็ใช้ env ที่ set ไว้ในเครื่อง/shell แทน
}

const app = require('./lib/app');
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`KPI evaluation dev server: http://localhost:${port}`);
});
