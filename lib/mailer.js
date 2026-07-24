// แจ้งเตือนอีเมล (เดิม: sendNotificationEmail_ ใน Code.gs) — ใช้ SMTP ทั่วไปผ่าน nodemailer
// เป็น optional feature: ถ้าไม่ได้ตั้งค่า SMTP_HOST/SMTP_USER/SMTP_PASS ไว้ จะข้ามการส่งเงียบ ๆ
// ไม่ throw เพื่อไม่ให้ error ของอีเมล (SMTP ล่ม, ที่อยู่ผิด ฯลฯ) ทำให้งานหลัก (ส่งหลักฐาน/ให้คะแนน) ล้มเหลวตามไปด้วย
const nodemailer = require('nodemailer');

let transporter;
let triedInit = false;

function getTransporter() {
  if (triedInit) return transporter;
  triedInit = true;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    transporter = null;
    return null;
  }
  const port = Number(SMTP_PORT) || 587;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendNotificationEmail(to, subject, text) {
  if (!to) return;
  const t = getTransporter();
  if (!t) return;
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
  } catch (err) {
    console.error('sendNotificationEmail failed:', err.message);
  }
}

module.exports = { sendNotificationEmail };
