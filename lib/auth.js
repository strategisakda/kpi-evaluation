// ระบบยืนยันตัวตน: bcrypt password + session token (เก็บ hash ใน DB, ไม่เก็บ plaintext)
// แก้ tech debt §7.1: #1 (SHA-256 อ่อน) #3 (ไม่มี rate limit) #4 (username enumeration) #7 (token plaintext)
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ชั่วโมง
const RATE_LIMIT_WINDOW_MIN = 15;
const RATE_LIMIT_MAX_FAILS = 5;
const isProd = !!process.env.VERCEL;

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function setSessionCookie(res, token, maxAgeMs) {
  const attrs = [
    `session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isProd) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = ['session=', 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (isProd) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

async function checkRateLimit(supabase, username) {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('username', username)
    .eq('success', false)
    .gte('created_at', since);
  if (error) throw error;
  return (count || 0) < RATE_LIMIT_MAX_FAILS;
}

async function recordLoginAttempt(supabase, username, success) {
  await supabase.from('login_attempts').insert({ username, success });
}

async function createSession(supabase, userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const { error } = await supabase
    .from('sessions')
    .insert({ user_id: userId, token_hash: hashToken(token), expires_at: expiresAt });
  if (error) throw error;
  return { token, expiresAt };
}

async function deleteSessionByToken(supabase, token) {
  await supabase.from('sessions').delete().eq('token_hash', hashToken(token));
}

async function getUserByToken(supabase, token) {
  if (!token) return null;
  const { data: session, error: sessErr } = await supabase
    .from('sessions')
    .select('user_id, expires_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  if (sessErr || !session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;

  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, username, display_name, role, district, contact_email')
    .eq('id', session.user_id)
    .maybeSingle();
  if (userErr || !user) return null;
  return user;
}

// middleware factory: requireAuth() = ต้อง login เฉยๆ, requireAuth(['Admin','SuperAdmin']) = ต้องมี role ตรง
function requireAuth(roles) {
  return async (req, res, next) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      if (!cookies.session) {
        return res.status(401).json({ ok: false, error: 'ยังไม่ได้เข้าสู่ระบบ หรือ session หมดอายุ' });
      }
      const supabase = require('./supabase').getSupabase();
      const user = await getUserByToken(supabase, cookies.session);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'ยังไม่ได้เข้าสู่ระบบ หรือ session หมดอายุ' });
      }
      if (roles && roles.length > 0 && !roles.includes(user.role)) {
        return res.status(403).json({ ok: false, error: 'ไม่มีสิทธิ์เข้าถึงส่วนนี้' });
      }
      req.user = user;
      next();
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}

module.exports = {
  verifyPassword,
  hashPassword,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  checkRateLimit,
  recordLoginAttempt,
  createSession,
  deleteSessionByToken,
  getUserByToken,
  requireAuth,
  SESSION_TTL_MS,
};
