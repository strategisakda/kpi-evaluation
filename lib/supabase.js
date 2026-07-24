// Supabase client (ฝั่ง server เท่านั้น — ใช้ service_role key)
// service_role bypass RLS จึงห้าม import ไฟล์นี้เข้าโค้ดฝั่ง browser เด็ดขาด
const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ดู .env.example)'
    );
  }
  if (!_client) {
    _client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}

module.exports = { getSupabase };
