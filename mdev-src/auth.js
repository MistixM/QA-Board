const SUPABASE_URL = 'https://bcellyymingygijatdij.supabase.co';
const ANON_KEY     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjZWxseXltaW5neWdpamF0ZGlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA2MjM3MDgsImV4cCI6MjA3NjE5OTcwOH0.htUYytZ8ft7nwQReKOpO8Xmg1sQmCUpCVxODSJZVp4A';

function getSession() {
  return new Promise(res => chrome.storage.local.get('ibSession', d => res(d.ibSession || null)));
}
function saveSession(s) {
  return new Promise(res => chrome.storage.local.set({ ibSession: s }, res));
}
function clearSession() {
  return new Promise(res => chrome.storage.local.remove('ibSession', res));
}

async function ibLogin(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    const e = await res.json();
    throw new Error(e.error_description || e.msg || 'Login failed');
  }
  const data = await res.json();
  await saveSession({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Math.floor(Date.now() / 1000) + data.expires_in,
    user_id:       data.user.id
  });
  return data;
}

async function ibGetToken() {
  const session = await getSession();
  if (!session) throw new Error('NOT_LOGGED_IN');

  const now = Math.floor(Date.now() / 1000);

  // Refresh if expiring within 2 minutes
  if (session.expires_at - now < 120) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!res.ok) { await clearSession(); throw new Error('NOT_LOGGED_IN'); }
    const data = await res.json();
    const fresh = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Math.floor(Date.now() / 1000) + data.expires_in,
      user_id:       session.user_id
    };
    await saveSession(fresh);
    return fresh.access_token;
  }

  return session.access_token;
}

async function ibLogout() { await clearSession(); }
