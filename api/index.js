// Entrypoint สำหรับ Vercel — ห่อ Express app เดิมให้รันเป็น serverless function
// vercel.json rewrite ทุก /api/* มาที่ไฟล์นี้
module.exports = require('../lib/app');
