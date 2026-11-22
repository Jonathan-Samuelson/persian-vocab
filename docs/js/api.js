// Data layer. Same function names as the SQL functions in supabase/schema.sql.
// Real mode calls Supabase over HTTPS; demo mode keeps everything in localStorage.
(function () {
  const cfg = window.APP_CONFIG || {};
  const DEMO = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;

  class ApiError extends Error { constructor(code, data) { super(code); this.code = code; this.data = data || {}; } }

  // ---------- real backend ----------
  async function rpc(fn, args) {
    let res;
    try {
      res = await fetch(cfg.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + cfg.SUPABASE_ANON_KEY },
        body: JSON.stringify(args || {}),
      });
    } catch (e) { throw new ApiError('NETWORK'); }
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!res.ok) {
      const msg = (body && (body.message || body.hint)) || '';
      const m = /([A-Z_]{4,})/.exec(msg);
      if (res.status === 540 || res.status === 503 || /paused/i.test(msg)) throw new ApiError('SERVER_PAUSED');
      throw new ApiError(m ? m[1] : 'SERVER_ERROR');
    }
    if (body && body.error) throw new ApiError(body.error, body);
    return body;
  }

  const real = {
    register: (name, pin, classCode) => rpc('register', { p_name: name, p_pin: pin, p_class_code: classCode }),
    login: (name, pin) => rpc('login', { p_name: name, p_pin: pin }),
    whoami: t => rpc('whoami', { p_token: t }),
    logout: t => rpc('logout', { p_token: t }),
    getProgress: t => rpc('get_progress', { p_token: t }),
    saveProgress: (t, items) => rpc('save_progress', { p_token: t, p_items: items }),
    resetMyProgress: t => rpc('reset_my_progress', { p_token: t }),
    adminOverview: t => rpc('admin_overview', { p_token: t }),
    adminUserProgress: (t, u) => rpc('admin_user_progress', { p_token: t, p_user: u }),
    adminGetSettings: t => rpc('admin_get_settings', { p_token: t }),
    adminSetSettings: (t, code, max) => rpc('admin_set_settings', { p_token: t, p_class_code: code, p_max_users: max }),
    adminResetPin: (t, u, pin) => rpc('admin_reset_pin', { p_token: t, p_user: u, p_pin: pin }),
    adminDeleteUser: (t, u) => rpc('admin_delete_user', { p_token: t, p_user: u }),
    adminExport: t => rpc('admin_export', { p_token: t }),
    adminUnlockUser: (t, u) => rpc('admin_unlock_user', { p_token: t, p_user: u }),
  };

  // ---------- demo backend (this browser only) ----------
  const KEY = 'fa-demo-db';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } };
  const store = db => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} };
  const fresh = () => ({ settings: { class_code: 'demo', max_users: 30 }, users: [], sessions: {}, progress: {} });
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const delay = v => new Promise(r => setTimeout(() => r(v), 120));
  function db() { return load() || fresh(); }
  function sessionUser(d, t) { const id = d.sessions[t]; const u = d.users.find(x => x.id === id); if (!u) throw new ApiError('SESSION_EXPIRED'); u.last_seen = new Date().toISOString(); return u; }
  function admin(d, t) { const u = sessionUser(d, t); if (!u.is_admin) throw new ApiError('NOT_ADMIN'); return u; }
  const rows = (d, id) => Object.entries(d.progress[id] || {}).map(([item_id, p]) => ({ item_id, ...p }));

  const demo = {
    async register(name, pin, code) {
      const d = db(); const n = String(name || '').trim().replace(/\s+/g, ' ');
      if (String(code || '').trim() !== d.settings.class_code) throw new ApiError('BAD_CLASS_CODE');
      if (n.length < 3 || n.length > 60 || !n.includes(' ')) throw new ApiError('BAD_NAME');
      if (!/^[0-9]{4}$/.test(pin)) throw new ApiError('BAD_PIN');
      if (d.users.length >= d.settings.max_users) throw new ApiError('FULL');
      if (d.users.some(u => u.name_key === norm(n))) throw new ApiError('NAME_TAKEN');
      const u = { id: uid(), display_name: n, name_key: norm(n), pin, is_admin: d.users.length === 0, created_at: new Date().toISOString(), last_seen: new Date().toISOString() };
      d.users.push(u); const t = uid(); d.sessions[t] = u.id; store(d);
      return delay({ token: t, name: n, is_admin: u.is_admin });
    },
    async login(name, pin) {
      // Same rules as the SQL login(): 10 wrong PINs within 24h lock the account for 24h.
      const d = db(); const u = d.users.find(x => x.name_key === norm(name)); const now = Date.now(), DAY = 864e5;
      if (!u) throw new ApiError('NO_SUCH_USER');
      if (u.locked_until && u.locked_until > now) throw new ApiError('LOCKED', { locked_until: new Date(u.locked_until).toISOString() });
      if (!u.first_failed_at || u.first_failed_at < now - DAY) { u.failed = 0; u.first_failed_at = null; }
      if (u.pin !== pin) {
        u.failed = (u.failed || 0) + 1; u.first_failed_at = u.first_failed_at || now;
        if (u.failed >= 10) { u.failed = 0; u.first_failed_at = null; u.locked_until = now + DAY; store(d); throw new ApiError('LOCKED', { locked_until: new Date(u.locked_until).toISOString() }); }
        store(d); throw new ApiError('BAD_PIN', { remaining: 10 - u.failed });
      }
      u.failed = 0; u.first_failed_at = null; u.locked_until = null;
      const t = uid(); d.sessions[t] = u.id; store(d); return delay({ token: t, name: u.display_name, is_admin: u.is_admin });
    },
    async whoami(t) { const d = db(); const u = sessionUser(d, t); store(d); return delay({ name: u.display_name, is_admin: u.is_admin }); },
    async logout(t) { const d = db(); delete d.sessions[t]; store(d); return delay(null); },
    async getProgress(t) { const d = db(); const u = sessionUser(d, t); store(d); return delay(rows(d, u.id)); },
    async saveProgress(t, items) {
      const d = db(); const u = sessionUser(d, t); const p = d.progress[u.id] = d.progress[u.id] || {};
      for (const it of items) { const o = p[it.id] || { status: 1, correct: 0, wrong: 0 }; p[it.id] = { status: it.status, correct: o.correct + (it.correct || 0), wrong: o.wrong + (it.wrong || 0), updated_at: new Date().toISOString() }; }
      store(d); return delay(items.length);
    },
    async resetMyProgress(t) { const d = db(); const u = sessionUser(d, t); d.progress[u.id] = {}; store(d); return delay(null); },
    async adminOverview(t) {
      const d = db(); admin(d, t);
      const now = Date.now();
      return delay(d.users.map(u => { const r = rows(d, u.id); const locked = !!(u.locked_until && u.locked_until > now); return { user_id: u.id, name: u.display_name, is_admin: u.is_admin, created_at: u.created_at, last_seen: u.last_seen, known: r.filter(x => x.status === 2).length, learning: r.filter(x => x.status === 1).length, answers: r.reduce((s, x) => s + x.correct + x.wrong, 0), locked, locked_until: locked ? new Date(u.locked_until).toISOString() : null, failed_attempts: (u.first_failed_at && u.first_failed_at > now - 864e5) ? u.failed : 0 }; }));
    },
    async adminUnlockUser(t, id) { const d = db(); admin(d, t); const u = d.users.find(x => x.id === id); if (u) { u.locked_until = null; u.failed = 0; u.first_failed_at = null; } store(d); return delay(null); },
    async adminUserProgress(t, id) { const d = db(); admin(d, t); return delay(rows(d, id)); },
    async adminGetSettings(t) { const d = db(); admin(d, t); return delay({ ...d.settings, user_count: d.users.length }); },
    async adminSetSettings(t, code, max) { const d = db(); admin(d, t); if (String(code).trim().length < 4) throw new ApiError('BAD_CLASS_CODE'); if (!(max >= 1 && max <= 30)) throw new ApiError('BAD_MAX'); d.settings = { class_code: String(code).trim(), max_users: max }; store(d); return delay(null); },
    async adminResetPin(t, id, pin) { const d = db(); admin(d, t); if (!/^[0-9]{4}$/.test(pin)) throw new ApiError('BAD_PIN'); const u = d.users.find(x => x.id === id); if (u) u.pin = pin; store(d); return delay(null); },
    async adminDeleteUser(t, id) { const d = db(); const me = admin(d, t); if (me.id === id) throw new ApiError('CANNOT_DELETE_SELF'); d.users = d.users.filter(x => x.id !== id); delete d.progress[id]; store(d); return delay(null); },
    async adminExport(t) { const d = db(); admin(d, t); return delay({ exported_at: new Date().toISOString(), users: d.users.map(u => ({ id: u.id, name: u.display_name, is_admin: u.is_admin, created_at: u.created_at, last_seen: u.last_seen })), progress: d.users.flatMap(u => rows(d, u.id).map(r => ({ user_id: u.id, ...r }))) }); },
  };

  window.Api = Object.assign({ DEMO, ApiError }, DEMO ? demo : real);
})();
