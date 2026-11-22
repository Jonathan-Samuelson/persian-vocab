// Persian vocabulary trainer: UI.
(function () {
  'use strict';
  const V = window.VOCAB, S = V.sources, Api = window.Api;
  const ALL = [...V.words.map(x => ({ ...x, kind: 'word' })), ...V.verbs.map(x => ({ ...x, kind: 'verb' }))];
  const BY_ID = new Map(ALL.map(x => [x.id, x]));
  const ORDER_W = ['שם עצם', 'שם תואר', 'כינוי גוף / רמז', 'מילת יחס', 'מילת שאלה', 'מספר', 'נומרטיב (מילית מנייה)', 'תואר פועל / זמן', 'מילות קישור וביטויים'];
  const ORDER_V = ['פועל פשוט', 'פועל מורכב'];
  const SRC_GROUPS = [
    ['רשימות מילים', k => k[0] === 'L'],
    ['מצגות וחומרי שיעור', k => k[0] === 'P' || k === 'S'],
    ['מטלות ובוחן', k => k[0] === 'H' || k === 'QZ'],
  ];
  const ERR = {
    BAD_CLASS_CODE: 'קוד הכיתה שגוי. בקש אותו ממנהל האתר.',
    BAD_NAME: 'כתוב שם מלא: שם פרטי ושם משפחה (3 עד 60 תווים).',
    BAD_PIN: 'הקוד האישי צריך להיות 4 ספרות.',
    FULL: 'ההרשמה סגורה: הגענו למספר המשתמשים המרבי.',
    NAME_TAKEN: 'השם הזה כבר רשום. אם זה אתה, עבור ל"כניסה" והקלד את הקוד האישי שלך.',
    NO_SUCH_USER: 'לא מצאנו משתמש בשם הזה. בדוק את האיות, או הירשם.',
    LOCKED: 'החשבון נעול ל-24 שעות אחרי 10 ניסיונות שגויים. אפשר לבקש ממנהל האתר לבטל את הנעילה.',
    SESSION_EXPIRED: 'פג תוקף הכניסה. היכנס שוב.',
    NOT_ADMIN: 'אין לך הרשאת מנהל.',
    NETWORK: 'אין חיבור לשרת. בדוק את החיבור לאינטרנט ונסה שוב.',
    SERVER_PAUSED: 'השרת במצב השהיה. פנה למנהל האתר כדי שיפעיל אותו מחדש.',
    CANNOT_DELETE_SELF: 'אי אפשר למחוק את המשתמש שלך.',
    BAD_MAX: 'מספר המשתמשים המרבי צריך להיות בין 1 ל-30.',
    SERVER_ERROR: 'שגיאה בשרת. נסה שוב בעוד רגע.',
  };
  const errText = e => ERR[e && e.code] || ERR.SERVER_ERROR;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const fmtDate = s => { if (!s) return '—'; const d = new Date(s); return d.toLocaleDateString('he-IL') + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); };

  // ---------- state ----------
  let session = ls.get('fa-session', null);      // {token, name, is_admin}
  let progress = new Map();                      // id -> {status, correct, wrong}
  let pending = new Map();                       // id -> {id, status, correct, wrong} not yet saved
  let banner = null;
  const app = $('#app');

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2200);
  }
  const statusOf = id => (progress.get(id) || {}).status || 0;

  // ---------- saving ----------
  function record(id, ok) {
    const p = progress.get(id) || { status: 0, correct: 0, wrong: 0 };
    p.status = ok ? 2 : 1; ok ? p.correct++ : p.wrong++;
    progress.set(id, p);
    if (!session) return;   // guest: counts for this visit only, nothing is saved
    const q = pending.get(id) || { id, status: 1, correct: 0, wrong: 0 };
    q.status = p.status; ok ? q.correct++ : q.wrong++;
    pending.set(id, q);
    ls.set('fa-pending-' + session.name, Array.from(pending.values()));
    scheduleFlush();
  }
  function scheduleFlush() { clearTimeout(scheduleFlush._t); scheduleFlush._t = setTimeout(flush, 2500); }
  async function flush() {
    if (!session || !pending.size || flush.busy) return;
    flush.busy = true;
    const batch = Array.from(pending.values());
    try {
      await Api.saveProgress(session.token, batch);
      for (const b of batch) { const cur = pending.get(b.id); if (cur === b) pending.delete(b.id); }
      ls.set('fa-pending-' + session.name, Array.from(pending.values()));
      setBanner(null);
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED') return signOut(ERR.SESSION_EXPIRED);
      setBanner('לא הצלחנו לשמור את ההתקדמות האחרונה. היא נשמרה בדפדפן וננסה שוב אוטומטית.', true);
      clearTimeout(scheduleFlush._t); scheduleFlush._t = setTimeout(flush, 15000);
    } finally { flush.busy = false; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);

  function setBanner(text, isErr) {
    banner = text ? { text, isErr } : null;
    const b = $('#banner'); if (!b) return;
    b.hidden = !banner; if (banner) { b.textContent = banner.text; b.className = 'banner' + (banner.isErr ? ' err' : ''); }
  }

  // ---------- auth ----------
  async function signIn(res) {
    session = { token: res.token, name: res.name, is_admin: !!res.is_admin };
    ls.set('fa-session', session);
    quiz = null;
    await loadProgress();
    go('#practice');
  }
  async function signOut(msg) {
    try { await flush(); } catch (e) {}
    if (session) { try { await Api.logout(session.token); } catch (e) {} }
    session = null; progress = new Map(); pending = new Map(); quiz = null; ls.del('fa-session');
    if (msg) { go('#login', false); renderLogin(msg, 'login'); } else go('#vocab');
  }
  // Change the hash and render, even when the hash is already the target.
  function go(hash, render = true) {
    if (location.hash === hash) { if (render) route(); }
    else if (render) location.hash = hash;
    else history.replaceState(null, '', hash);
  }
  async function loadProgress() {
    const rows = await Api.getProgress(session.token);
    progress = new Map((rows || []).map(r => [r.item_id, { status: r.status, correct: r.correct, wrong: r.wrong }]));
    // Re-apply answers that were saved in the browser but never reached the server.
    const saved = ls.get('fa-pending-' + session.name, []);
    pending = new Map(saved.map(x => [x.id, x]));
    for (const q of saved) { const p = progress.get(q.id) || { status: 0, correct: 0, wrong: 0 }; p.status = q.status; p.correct += q.correct; p.wrong += q.wrong; progress.set(q.id, p); }
    if (pending.size) scheduleFlush();
  }

  function renderLogin(msg, tab) {
    tab = tab || ls.get('fa-login-tab', 'login');
    app.innerHTML = `
      <div class="login">
        <div class="brand" style="justify-content:center;margin-bottom:6px"><span class="fa">فارسی</span><h1>אוצר מילים 38126</h1></div>
        <p class="muted" style="text-align:center;margin-top:0">פרסית למתחילים, חלק א׳: תרגול ומעקב התקדמות</p>
        ${Api.DEMO ? '<p class="banner">מצב הדגמה: הנתונים נשמרים רק בדפדפן הזה. קוד הכיתה בהדגמה הוא <b>demo</b>.</p>' : ''}
        <div class="panel">
          <div class="tabs seg" role="group" aria-label="כניסה או הרשמה">
            <button id="t-login" aria-pressed="${tab === 'login'}">כניסה</button>
            <button id="t-reg" aria-pressed="${tab === 'register'}">הרשמה ראשונה</button>
          </div>
          <form id="authform" novalidate>
            <div class="field"><label for="f-name">שם מלא</label>
              <input type="text" id="f-name" autocomplete="name" required placeholder="למשל: דנה לוי"></div>
            <div class="field"><label for="f-pin">קוד אישי (4 ספרות)</label>
              <input type="password" id="f-pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="${tab === 'login' ? 'current-password' : 'new-password'}" required>
              ${tab === 'register' ? '<small>בחר 4 ספרות ותזכור אותן. בעזרתן תיכנס גם ממכשיר אחר.</small>' : ''}</div>
            ${tab === 'register' ? `<div class="field"><label for="f-code">קוד הכיתה</label>
              <input type="text" id="f-code" autocomplete="off" required><small>מקבלים אותו ממנהל האתר.</small></div>` : ''}
            <p class="err" id="f-err" ${msg ? '' : 'hidden'}>${esc(msg || '')}</p>
            <button class="btn primary" id="f-go" type="submit">${tab === 'login' ? 'כניסה' : 'הרשמה וכניסה'}</button>
            ${tab === 'login' ? '<small class="muted">שכחת את הקוד? פנה למנהל האתר והוא יאפס לך אותו.</small>' : ''}
          </form>
        </div>
        <p style="text-align:center"><a href="#vocab" id="as-guest">להמשיך לאתר בלי להתחבר ←</a><br>
          <small class="muted">אפשר לעיין ולתרגל גם בלי משתמש, אבל ההתקדמות לא תישמר.</small></p>
      </div>`;
    $('#t-login').onclick = () => { ls.set('fa-login-tab', 'login'); go('#login'); };
    $('#t-reg').onclick = () => { ls.set('fa-login-tab', 'register'); go('#register'); };
    $('#authform').onsubmit = async ev => {
      ev.preventDefault();
      const name = $('#f-name').value, pin = $('#f-pin').value.trim(), btn = $('#f-go'), err = $('#f-err');
      err.hidden = true; btn.disabled = true;
      try {
        if (!/^[0-9]{4}$/.test(pin)) throw new Api.ApiError('BAD_PIN');
        const res = tab === 'login' ? await Api.login(name, pin) : await Api.register(name, pin, $('#f-code').value);
        ls.set('fa-login-tab', 'login');
        await signIn(res);
      } catch (e) {
        const wrongPin = tab === 'login' && e.code === 'BAD_PIN' && /^[0-9]{4}$/.test(pin);
        const left = e.data && e.data.remaining;
        const until = e.data && e.data.locked_until;
        err.textContent = wrongPin
          ? `הקוד האישי שגוי. ${left === 1 ? 'נותר ניסיון אחד' : `נותרו ${left == null ? 'עוד כמה' : left} ניסיונות`} לפני שהחשבון יינעל ל-24 שעות.`
          : e.code === 'LOCKED' && until
            ? `החשבון נעול עד ${fmtDate(until)} אחרי 10 ניסיונות שגויים. אפשר לבקש ממנהל האתר לבטל את הנעילה.`
            : errText(e);
        err.hidden = false; btn.disabled = false;
      }
    };
    $('#f-name').focus();
  }

  // ---------- shell ----------
  const VIEWS = { practice: 'תרגול', vocab: 'אוצר מילים', progress: 'ההתקדמות שלי', admin: 'ניהול' };
  const GUEST_VIEWS = ['vocab', 'practice'];
  function shell(view) {
    const links = Object.entries(VIEWS)
      .filter(([k]) => session ? (k !== 'admin' || session.is_admin) : GUEST_VIEWS.includes(k))
      .map(([k, v]) => `<a href="#${k}" ${k === view ? 'aria-current="page"' : ''}>${v}</a>`).join('');
    const who = session
      ? `<span>שלום, ${esc(session.name)}</span><button class="linkbtn" id="logout">יציאה</button>`
      : `<span class="muted">צופה כאורח</span><a class="btn small" href="#login">כניסה</a><a class="btn small primary" href="#register">הרשמה</a>`;
    app.innerHTML = `
      <div class="top">
        <div class="brand"><span class="fa">فارسی</span><strong>38126</strong></div>
        <nav class="nav" aria-label="ניווט">${links}</nav>
        <div class="who">${who}</div>
      </div>
      ${Api.DEMO ? '<p class="banner">מצב הדגמה: הנתונים נשמרים רק בדפדפן הזה.</p>' : ''}
      ${session ? '' : `<p class="banner guest">אתם צופים באתר כאורחים: אפשר לעיין באוצר המילים ולתרגל, אבל ההתקדמות לא נשמרת.
        כדי לשמור אותה <a href="#login">היכנסו</a> או <a href="#register">צרו משתמש</a>.</p>`}
      <p id="banner" hidden></p>
      <main id="view"></main>`;
    if (session) $('#logout').onclick = () => signOut();
    setBanner(banner && banner.text, banner && banner.isErr);
    return $('#view');
  }

  function route() {
    const h = location.hash.slice(1);
    if (h === 'login' || h === 'register') {
      if (session) return go('#practice');
      quiz = null;
      return renderLogin(null, h);
    }
    let view = h || (session ? 'practice' : 'vocab');
    if (session) { if (!VIEWS[view] || (view === 'admin' && !session.is_admin)) view = 'practice'; }
    else if (!GUEST_VIEWS.includes(view)) view = 'vocab';
    if (quiz && view !== 'practice') quiz = null;
    const el = shell(view);
    ({ practice: renderPractice, vocab: renderVocab, progress: renderProgress, admin: renderAdmin })[view](el);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // ---------- helpers for counts ----------
  function countsFor(items) {
    let k = 0, l = 0; for (const x of items) { const s = statusOf(x.id); if (s === 2) k++; else if (s === 1) l++; }
    return { known: k, learning: l, fresh: items.length - k - l, total: items.length };
  }
  const itemsOfSource = k => ALL.filter(x => x.src.includes(k));
  const chip = k => `<span class="chip ${k[0]}">${esc(S[k])}</span>`;
  const stBadge = s => s === 2 ? '<span class="st s2">✓ ידוע</span>' : s === 1 ? '<span class="st s1">בלמידה</span>' : '<span class="st s0">חדש</span>';

  // ---------- vocab view ----------
  function renderVocab(el) {
    const st = Object.assign({ tab: 'words', f: 'all', status: 'all', src: '' }, ls.get('fa-vocab', {}), { q: '' });
    el.innerHTML = `
      <div class="bar">
        <div class="row">
          <div class="seg" role="group" aria-label="סוג">
            <button data-tab="words">מילים</button><button data-tab="verbs">פעלים</button><button data-tab="all">הכול</button>
          </div>
          <span class="count" id="v-count"></span>
        </div>
        <div class="row">
          <div class="seg" role="group" aria-label="רשימות">
            <button data-f="all">כל המקורות</button><button data-f="list">רק מרשימות המילים</button><button data-f="new">רק מה שלא ברשימות</button>
          </div>
        </div>
        ${session ? `<div class="row">
          <div class="seg" role="group" aria-label="סטטוס">
            <button data-s="all">כל הסטטוסים</button><button data-s="2">ידוע</button><button data-s="1">בלמידה</button><button data-s="0">חדש</button>
          </div>
        </div>` : ''}
        <div class="row">
          <input type="search" id="v-q" placeholder="חיפוש בפרסית, בעברית או בתעתיק" aria-label="חיפוש">
          <select id="v-src" aria-label="מקור"><option value="">כל קובץ</option>${Object.entries(S).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        </div>
      </div>
      <div id="v-out"></div>`;
    const pass = x => {
      if (st.tab === 'words' && x.kind !== 'word') return false;
      if (st.tab === 'verbs' && x.kind !== 'verb') return false;
      if (st.f === 'list' && !x.inList) return false;
      if (st.f === 'new' && x.inList) return false;
      if (session && st.status !== 'all' && String(statusOf(x.id)) !== st.status) return false;
      if (st.src && !x.src.includes(st.src)) return false;
      if (st.q) { const q = st.q.toLowerCase(); if (!(x.fa + ' ' + x.tr + ' ' + x.he).toLowerCase().includes(q)) return false; }
      return true;
    };
    function draw() {
      let html = '', n = 0;
      const groups = [...ORDER_W.map(c => [c, false]), ...ORDER_V.map(c => [c, true])];
      for (const [c, verb] of groups) {
        const rows = ALL.filter(x => x.cat === c && pass(x)); if (!rows.length) continue; n += rows.length;
        html += `<section class="group"><h2>${verb ? 'פעלים · ' : ''}${esc(c)}<small>${rows.length}</small></h2><div class="tbl"><table>
          <thead><tr><th>פרסית</th><th class="tr">תעתיק</th><th>תרגום</th>${verb ? '<th>גזע עבר</th>' : ''}${session ? '<th>אצלי</th>' : ''}<th>מקור</th></tr></thead><tbody>
          ${rows.map(x => `<tr><td class="fa">${esc(x.fa)}</td><td class="tr">${esc(x.tr)}</td><td>${esc(x.he)}${x.inList ? '' : '<span class="new">לא ברשימה</span>'}</td>${verb ? `<td class="stem">${esc(x.stem)}</td>` : ''}${session ? `<td>${stBadge(statusOf(x.id))}</td>` : ''}<td class="src">${x.src.map(chip).join('')}</td></tr>`).join('')}
          </tbody></table></div></section>`;
      }
      $('#v-out').innerHTML = html || '<p class="muted" style="padding:30px;text-align:center">אין פריטים שמתאימים לסינון הזה.</p>';
      $('#v-count').textContent = n + ' מוצגים';
      $$('[data-tab]', el).forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === st.tab));
      $$('[data-f]', el).forEach(b => b.setAttribute('aria-pressed', b.dataset.f === st.f));
      $$('[data-s]', el).forEach(b => b.setAttribute('aria-pressed', b.dataset.s === st.status));
      $('#v-src').value = st.src;
      ls.set('fa-vocab', { tab: st.tab, f: st.f, status: st.status, src: st.src });
    }
    $$('[data-tab]', el).forEach(b => b.onclick = () => { st.tab = b.dataset.tab; draw(); });
    $$('[data-f]', el).forEach(b => b.onclick = () => { st.f = b.dataset.f; draw(); });
    $$('[data-s]', el).forEach(b => b.onclick = () => { st.status = b.dataset.s; draw(); });
    $('#v-q').oninput = e => { st.q = e.target.value.trim(); draw(); };
    $('#v-src').onchange = e => { st.src = e.target.value; draw(); };
    draw();
  }

  // ---------- practice ----------
  let quiz = null;
  const DEFAULT_SETUP = { sources: ['L1', 'L2', 'L3', 'L4'], kind: 'all', which: 'unknown', dir: 'fa-he', mode: 'cards', size: '20', translit: true };
  const setupKey = () => 'fa-setup-' + (session ? session.name : '~guest');
  function getSetup() { const s = Object.assign({}, DEFAULT_SETUP, ls.get(setupKey(), {})); s.sources = s.sources.filter(k => S[k]); return s; }
  function saveSetup(s) { ls.set(setupKey(), s); }
  function pool(s) {
    return ALL.filter(x => x.src.some(k => s.sources.includes(k)))
      .filter(x => s.kind === 'all' || (s.kind === 'words' ? x.kind === 'word' : x.kind === 'verb'))
      .filter(x => s.which === 'all' || (s.which === 'unknown' ? statusOf(x.id) !== 2 : statusOf(x.id) === 1));
  }

  function renderPractice(el) {
    if (quiz) return renderQuiz(el);
    const s = getSetup();
    const groupHtml = SRC_GROUPS.map(([title, f], gi) => {
      const keys = Object.keys(S).filter(f);
      return `<div class="grouphead"><h3>${title}</h3><button class="btn small" data-gall="${gi}">סמן הכול</button><button class="btn small" data-gnone="${gi}">נקה</button></div>
        <div class="srcgrid">${keys.map(k => { const c = countsFor(itemsOfSource(k)); return `<label><input type="checkbox" value="${k}" ${s.sources.includes(k) ? 'checked' : ''}><span class="name">${esc(S[k])}</span><span class="cnt">${c.known}/${c.total} ✓</span></label>`; }).join('')}</div>`;
    }).join('');
    const seg = (name, opts) => `<div class="seg" role="group" data-name="${name}">${opts.map(([v, t]) => `<button data-v="${v}" aria-pressed="${s[name] === v}">${t}</button>`).join('')}</div>`;
    el.innerHTML = `
      <div class="stack" style="margin-top:18px">
        <div class="panel">
          <h2>על מה לתרגל?</h2>
          <div class="row"><button class="btn small" id="p-all">כל המקורות</button><button class="btn small" id="p-none">נקה הכול</button></div>
          ${groupHtml}
        </div>
        <div class="panel">
          <h2>איך לתרגל?</h2>
          <div class="opts">
            <div class="field"><label>שיטה</label>${seg('mode', [['cards', 'כרטיסיות'], ['mc', 'מבחן אמריקאי'], ['type', 'הקלדה']])}
              <span class="mode-note" id="mode-note"></span></div>
            <div class="field"><label>כיוון</label>${seg('dir', [['fa-he', 'פרסית ← עברית'], ['he-fa', 'עברית ← פרסית'], ['mix', 'מעורב']])}</div>
            <div class="field"><label>אילו פריטים</label>${seg('which', [['unknown', 'מה שעוד לא ✓'], ['learning', 'רק מה שטעיתי בו'], ['all', 'הכול']])}</div>
            <div class="field"><label>סוג</label>${seg('kind', [['all', 'מילים ופעלים'], ['words', 'רק מילים'], ['verbs', 'רק פעלים']])}</div>
            <div class="field"><label>כמה בסבב</label>${seg('size', [['10', '10'], ['20', '20'], ['50', '50'], ['all', 'הכול']])}</div>
            <div class="field"><label for="p-tr">תעתיק לטיני</label><label class="row" style="font-weight:400"><input type="checkbox" id="p-tr" ${s.translit ? 'checked' : ''}> להציג תעתיק ליד המילה הפרסית</label></div>
          </div>
        </div>
        <div class="startbar"><button class="btn primary" id="p-start">התחל תרגול</button><span class="muted" id="p-count"></span></div>
      </div>`;
    const NOTES = { cards: 'רואים מילה, הופכים את הכרטיס ומסמנים בעצמכם ✓ או ✗. השיטה המומלצת.', mc: 'בוחרים את התשובה הנכונה מתוך 4.', type: 'מקלידים את התשובה. טעות קטנה באות אחת או החלפת סדר של שתי אותיות עדיין נחשבת נכונה.' };
    function sync() {
      s.sources = $$('.srcgrid input:checked', el).map(i => i.value);
      s.translit = $('#p-tr').checked;
      const n = pool(s).length, take = s.size === 'all' ? n : Math.min(n, +s.size);
      $('#p-count').textContent = s.sources.length ? (n ? `${take} פריטים בסבב (מתוך ${n} מתאימים)` : 'אין פריטים מתאימים. נסה לבחור "הכול" או מקורות נוספים.') : 'בחר לפחות מקור אחד.';
      $('#p-start').disabled = !n;
      $('#mode-note').textContent = NOTES[s.mode];
      saveSetup(s);
    }
    $$('.seg[data-name]', el).forEach(g => $$('button', g).forEach(b => b.onclick = () => {
      s[g.dataset.name] = b.dataset.v; $$('button', g).forEach(x => x.setAttribute('aria-pressed', x === b)); sync();
    }));
    $$('.srcgrid input', el).forEach(i => i.onchange = sync);
    $('#p-tr').onchange = sync;
    $$('[data-gall]', el).forEach(b => b.onclick = () => { $$('.srcgrid', el)[+b.dataset.gall].querySelectorAll('input').forEach(i => i.checked = true); sync(); });
    $$('[data-gnone]', el).forEach(b => b.onclick = () => { $$('.srcgrid', el)[+b.dataset.gnone].querySelectorAll('input').forEach(i => i.checked = false); sync(); });
    $('#p-all').onclick = () => { $$('.srcgrid input', el).forEach(i => i.checked = true); sync(); };
    $('#p-none').onclick = () => { $$('.srcgrid input', el).forEach(i => i.checked = false); sync(); };
    $('#p-start').onclick = () => { startQuiz(s, null); };
    sync();
  }

  function startQuiz(s, onlyItems) {
    let items = onlyItems || shuffle(pool(s));
    if (!onlyItems && s.size !== 'all') items = items.slice(0, +s.size);
    quiz = {
      s, total: items.length, queue: items.map(x => ({ x, dir: s.dir === 'mix' ? (Math.random() < .5 ? 'fa-he' : 'he-fa') : s.dir })),
      done: 0, right: 0, wrong: 0, missed: new Map(), repeats: new Map(), answered: false, flipped: false, finished: false,
    };
    renderQuiz($('#view'));
  }

  // After a wrong answer the item comes back a few cards later (at most twice per round).
  function answer(ok) {
    const cur = quiz.queue.shift();
    record(cur.x.id, ok);
    if (ok) quiz.right++; else { quiz.wrong++; quiz.missed.set(cur.x.id, cur.x); }
    const r = quiz.repeats.get(cur.x.id) || 0;
    if (!ok && r < 2) { quiz.repeats.set(cur.x.id, r + 1); quiz.queue.splice(Math.min(3, quiz.queue.length), 0, { x: cur.x, dir: cur.dir, repeat: true }); }
    else quiz.done++;   // the item leaves the round for good
    quiz.answered = false; quiz.flipped = false; quiz.pick = null; quiz.typed = null;
    if (!quiz.queue.length) { quiz.finished = true; flush(); }
    renderQuiz($('#view'));
  }

  const promptOf = (x, dir) => dir === 'fa-he' ? x.fa : x.he;
  const answerOf = (x, dir) => dir === 'fa-he' ? x.he : x.fa;
  function distractors(x, dir) {
    const key = it => answerOf(it, dir);
    const mine = key(x);
    let cands = ALL.filter(o => o.id !== x.id && o.kind === x.kind && key(o) !== mine);
    const same = cands.filter(o => o.cat === x.cat);
    const pick = shuffle(same.length >= 3 ? same : cands);
    const out = [], seen = new Set([mine]);
    for (const o of pick) { if (!seen.has(key(o))) { seen.add(key(o)); out.push(o); } if (out.length === 3) break; }
    return out;
  }

  function renderQuiz(el) {
    const q = quiz;
    if (q.finished) return renderSummary(el);
    const cur = q.queue[0], x = cur.x, dir = cur.dir, faPrompt = dir === 'fa-he';
    const pct = Math.round(100 * q.done / Math.max(1, q.total));
    const trLine = (q.s.translit && faPrompt) ? `<div class="tr">${esc(x.tr)}</div>` : '';
    const meta = `<div class="meta">${esc(x.cat)}${x.kind === 'verb' && x.stem ? ' · גזע עבר: <span class="fa">' + esc(x.stem) + '</span>' : ''}</div>`;
    const promptHtml = `<div class="prompt ${faPrompt ? 'fa' : 'he'}" ${faPrompt ? 'dir="rtl" lang="fa"' : ''}>${esc(promptOf(x, dir))}</div>${trLine}`;
    const answerHtml = `<div class="answer"><div class="big ${faPrompt ? '' : 'fa'}" ${faPrompt ? '' : 'lang="fa"'}>${esc(answerOf(x, dir))}</div>${!faPrompt && q.s.translit ? `<div class="tr">${esc(x.tr)}</div>` : ''}${meta}</div>`;
    let body = '';
    if (q.s.mode === 'cards') {
      body = `<div class="card flip" id="card" role="button" tabindex="0" aria-label="הפוך כרטיס">${promptHtml}${q.flipped ? answerHtml : '<div class="hint">לחצו על הכרטיס או על רווח כדי לראות את התשובה</div>'}</div>
        ${q.flipped ? `<div class="marks"><button class="mark no" id="m-no">✗ לא ידעתי <small class="muted">(1)</small></button><button class="mark yes" id="m-yes">✓ ידעתי <small class="muted">(2)</small></button></div>` : ''}`;
    } else if (q.s.mode === 'mc') {
      if (!cur.opts) cur.opts = shuffle([x, ...distractors(x, dir)]);
      body = `<div class="card">${promptHtml}${q.answered ? meta : ''}</div>
        <div class="choices">${cur.opts.map((o, i) => {
          let cls = 'choice' + (faPrompt ? '' : ' fa');
          if (q.answered) { if (o.id === x.id) cls += ' right'; else if (q.pick === o.id) cls += ' wrongpick'; }
          return `<button class="${cls}" data-o="${esc(o.id)}" ${q.answered ? 'disabled' : ''}><kbd>${i + 1}</kbd>${esc(answerOf(o, dir))}</button>`;
        }).join('')}</div>
        ${q.answered ? `<button class="btn primary" id="next">הבא ←</button>` : ''}`;
    } else {
      const ph = faPrompt ? 'כתבו את התרגום בעברית' : 'כתבו בפרסית או בתעתיק לטיני';
      let verdict = '';
      if (q.typed) {
        const t = q.typed;
        verdict = t.verdict === 'exact' ? `<div class="verdict exact">✓ נכון!</div>`
          : t.verdict === 'close' ? `<div class="verdict close">✓ כמעט מדויק, וזה נחשב נכון. הכתיב המדויק: <span ${faPrompt ? '' : 'class="fa"'}>${esc(t.best)}</span></div>`
          : `<div class="verdict wrong">✗ התשובה: <span ${faPrompt ? '' : 'class="fa"'}>${esc(answerOf(x, dir))}</span>${!faPrompt ? ` <span class="muted" dir="ltr">(${esc(x.tr)})</span>` : ''}</div>`;
      }
      body = `<div class="card">${promptHtml}${q.typed ? meta : ''}</div>
        <form class="typebox" id="tform"><input type="text" id="t-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${ph}" ${q.typed ? 'disabled' : ''} value="${q.typed ? esc(q.typed.input) : ''}"><button class="btn primary" type="submit">${q.typed ? 'הבא ←' : 'בדיקה'}</button></form>
        ${verdict}
        ${q.typed && q.typed.verdict === 'wrong' ? '<div class="row"><button class="btn small" id="t-override">בעצם צדקתי, תחשב כנכון</button></div>' : ''}
        ${q.typed && q.typed.verdict !== 'wrong' ? '<div class="row"><button class="btn small" id="t-override-wrong">בעצם טעיתי, תחשב כשגוי</button></div>' : ''}`;
    }
    el.innerHTML = `<div class="quiz">
      <div class="qtop"><span>${q.done} / ${q.total}</span><div class="meter" aria-hidden="true"><i style="width:${pct}%"></i></div><span>✓ ${q.right} · ✗ ${q.wrong}</span><button class="linkbtn" id="q-stop">סיום</button></div>
      ${cur.repeat ? '<div class="hint">חוזרים על מילה שטעיתם בה</div>' : ''}
      ${body}</div>`;
    $('#q-stop').onclick = () => { quiz.finished = true; flush(); renderQuiz(el); };
    if (q.s.mode === 'cards') {
      const flip = () => { if (!q.flipped) { q.flipped = true; renderQuiz(el); } };
      $('#card').onclick = flip;
      if (q.flipped) { $('#m-no').onclick = () => answer(false); $('#m-yes').onclick = () => answer(true); }
    } else if (q.s.mode === 'mc') {
      $$('.choice', el).forEach(b => b.onclick = () => {
        if (q.answered) return;
        q.answered = true; q.pick = b.dataset.o; const ok = q.pick === x.id;
        q.pendingOk = ok; renderQuiz(el);
        if (ok) { clearTimeout(q._t); q._t = setTimeout(() => { if (quiz === q && q.answered) answer(true); }, 900); }
      });
      if (q.answered) $('#next').onclick = () => { clearTimeout(q._t); answer(q.pendingOk); };
    } else {
      const inp = $('#t-in');
      $('#tform').onsubmit = ev => {
        ev.preventDefault();
        if (q.typed) return answer(q.typed.verdict !== 'wrong');
        const val = inp.value; if (!val.trim()) return;
        const answers = faPrompt ? [x.he] : [x.fa, x.tr];
        const r = window.Match.check(val, answers);
        q.typed = { input: val, verdict: r.verdict, best: r.best };
        renderQuiz(el);
      };
      const ov = $('#t-override'); if (ov) ov.onclick = () => { q.typed.verdict = 'exact'; answer(true); };
      const ovw = $('#t-override-wrong'); if (ovw) ovw.onclick = () => { q.typed.verdict = 'wrong'; answer(false); };
      if (!q.typed) inp.focus(); else $('#tform button').focus();
    }
  }

  document.addEventListener('keydown', ev => {
    if (!quiz || quiz.finished || !$('.quiz')) return;
    if (ev.target.tagName === 'INPUT' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const q = quiz;
    if (q.s.mode === 'cards') {
      if ((ev.key === ' ' || ev.key === 'Enter') && !q.flipped) { ev.preventDefault(); q.flipped = true; renderQuiz($('#view')); }
      else if (q.flipped && ev.key === '1') answer(false);
      else if (q.flipped && ev.key === '2') answer(true);
    } else if (q.s.mode === 'mc') {
      if (!q.answered && /^[1-4]$/.test(ev.key)) { const b = $$('.choice')[+ev.key - 1]; if (b) b.click(); }
      else if (q.answered && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); const n = $('#next'); if (n) n.click(); }
    }
  });

  function renderSummary(el) {
    const q = quiz, n = q.right + q.wrong, acc = n ? Math.round(100 * q.right / n) : 0;
    const missed = Array.from(q.missed.values());
    el.innerHTML = `<div class="quiz summary">
      <div class="panel stack">
        <h2>סיכום הסבב</h2>
        <div class="stats"><div class="stat"><b>${q.right}</b><span>תשובות נכונות</span></div><div class="stat"><b>${q.wrong}</b><span>טעויות</span></div><div class="stat"><b>${acc}%</b><span>דיוק</span></div></div>
        ${session
          ? '<p class="muted" style="margin:0">ההתקדמות נשמרה. מילים שסימנתם ✓ בתשובה האחרונה עליהן מסומנות כ"ידוע".</p>'
          : '<p class="banner guest" style="margin:0">במצב אורח ההתקדמות לא נשמרת. כדי לשמור אותה ולהמשיך מאותה נקודה בפעם הבאה, <a href="#login">היכנסו</a> או <a href="#register">צרו משתמש</a>.</p>'}
        ${missed.length ? `<h3>מילים לחזור עליהן</h3><div class="tbl"><table><tbody>${missed.map(x => `<tr><td class="fa">${esc(x.fa)}</td><td class="tr">${esc(x.tr)}</td><td>${esc(x.he)}</td><td>${stBadge(statusOf(x.id))}</td></tr>`).join('')}</tbody></table></div>` : '<p>בלי טעויות. כל הכבוד!</p>'}
        <div class="row">
          ${missed.length ? '<button class="btn primary" id="s-again">תרגל שוב את הטעויות</button>' : ''}
          <button class="btn ${missed.length ? '' : 'primary'}" id="s-new">סבב חדש</button>
          <button class="btn" id="s-setup">חזרה להגדרות</button>
        </div>
      </div></div>`;
    const s = q.s;
    if (missed.length) $('#s-again').onclick = () => startQuiz(s, shuffle(missed));
    $('#s-new').onclick = () => { quiz = null; startQuiz(s, null); if (!quiz.total) { quiz = null; route(); toast('אין עוד פריטים מתאימים להגדרות האלה'); } };
    $('#s-setup').onclick = () => { quiz = null; route(); };
  }

  // ---------- progress view ----------
  function progressBars(getStatus) {
    return SRC_GROUPS.map(([title, f]) => `<h3 style="margin-top:14px">${title}</h3><div class="prog">${Object.keys(S).filter(f).map(k => {
      const items = itemsOfSource(k); let kn = 0, le = 0; for (const x of items) { const s = getStatus(x.id); if (s === 2) kn++; else if (s === 1) le++; }
      const t = items.length;
      return `<span>${esc(S[k])}</span><div class="pbar" role="img" aria-label="${kn} ידועות, ${le} בלמידה מתוך ${t}"><span class="k" style="width:${100 * kn / t}%"></span><span class="l" style="width:${100 * le / t}%"></span></div><span class="num">${kn}/${t} ✓${le ? ` · ${le} בלמידה` : ''}</span>`;
    }).join('')}</div>`).join('');
  }
  function renderProgress(el) {
    const c = countsFor(ALL);
    let answers = 0; progress.forEach(p => { answers += p.correct + p.wrong; });
    el.innerHTML = `<div class="stack" style="margin-top:18px">
      <div class="stats">
        <div class="stat known"><b>${c.known}</b><span>ידועות</span></div>
        <div class="stat learning"><b>${c.learning}</b><span>בלמידה</span></div>
        <div class="stat"><b>${c.fresh}</b><span>עוד לא תרגלתי</span></div>
        <div class="stat"><b>${answers}</b><span>תשובות עד היום</span></div>
      </div>
      <div class="panel"><h2>לפי מקור</h2><p class="muted" style="margin:0 0 6px">ירוק: ידוע (סימנתם ✓). צהוב: בלמידה (התשובה האחרונה הייתה ✗).</p>${progressBars(statusOf)}</div>
      <div class="panel"><h2>איפוס</h2><p class="muted">מוחק את כל ההתקדמות שלך ומתחיל מחדש. אי אפשר לבטל את זה.</p>
        <div id="reset-area"><button class="btn danger" id="reset">אפס את ההתקדמות שלי</button></div></div>
    </div>`;
    $('#reset').onclick = () => {
      $('#reset-area').innerHTML = `<span class="confirm"><span>בטוח? כל ${progress.size} הפריטים שתרגלת יימחקו.</span><button class="btn danger small" id="reset-yes">כן, למחוק</button><button class="btn small" id="reset-no">ביטול</button></span>`;
      $('#reset-no').onclick = () => renderProgress(el);
      $('#reset-yes').onclick = async () => {
        try { await flush(); await Api.resetMyProgress(session.token); progress = new Map(); pending = new Map(); ls.del('fa-pending-' + session.name); toast('ההתקדמות אופסה'); renderProgress(el); }
        catch (e) { toast(errText(e)); }
      };
    };
  }

  // ---------- admin view ----------
  async function renderAdmin(el) {
    el.innerHTML = '<p class="muted" style="margin-top:18px">טוען נתוני ניהול…</p>';
    let users, settings;
    try { [users, settings] = await Promise.all([Api.adminOverview(session.token), Api.adminGetSettings(session.token)]); }
    catch (e) { if (e.code === 'SESSION_EXPIRED') return signOut(ERR.SESSION_EXPIRED); el.innerHTML = `<p class="err">${esc(errText(e))}</p>`; return; }
    const total = ALL.length;
    el.innerHTML = `<div class="stack" style="margin-top:18px">
      <div class="panel">
        <h2>הגדרות הרשמה</h2>
        <div class="row" style="align-items:flex-end;gap:14px">
          <div class="field"><label for="a-code">קוד הכיתה</label><input type="text" id="a-code" value="${esc(settings.class_code)}"><small>מי שאין לו את הקוד לא יכול להירשם.</small></div>
          <div class="field"><label for="a-max">מספר משתמשים מרבי</label><input type="number" id="a-max" min="1" max="30" value="${settings.max_users}" style="width:100px"><small>עד 30. כרגע רשומים ${settings.user_count}.</small></div>
          <button class="btn primary" id="a-save">שמירה</button>
        </div>
      </div>
      <div class="panel">
        <div class="row" style="justify-content:space-between"><h2 style="margin:0">משתמשים (${users.length})</h2>
          <div class="row"><button class="btn small" id="a-csv">הורד טבלה (CSV)</button><button class="btn small" id="a-backup">הורד גיבוי מלא (JSON)</button></div></div>
        <div class="tbl" style="margin-top:12px"><table>
          <thead><tr><th>שם</th><th>ידועות</th><th>בלמידה</th><th>תשובות</th><th>נרשם</th><th>פעיל לאחרונה</th><th></th></tr></thead>
          <tbody>${users.map(u => `<tr data-u="${esc(u.user_id)}">
            <td><strong>${esc(u.name)}</strong>${u.is_admin ? ' <span class="chip L">מנהל</span>' : ''}${u.locked ? ` <span class="chip H">נעול עד ${esc(fmtDate(u.locked_until))}</span>` : ''}${!u.locked && u.failed_attempts ? ` <span class="chip H">${u.failed_attempts} ניסיונות שגויים היום</span>` : ''}</td>
            <td class="num">${u.known} <span class="muted">(${Math.round(100 * u.known / total)}%)</span></td><td class="num">${u.learning}</td><td class="num">${u.answers}</td>
            <td class="num">${fmtDate(u.created_at)}</td><td class="num">${fmtDate(u.last_seen)}</td>
            <td><div class="row" style="flex-wrap:nowrap">${u.locked ? '<button class="btn small primary" data-act="unlock">בטל נעילה</button>' : ''}<button class="btn small" data-act="detail">פירוט</button><button class="btn small" data-act="pin">איפוס קוד</button>${u.is_admin ? '' : '<button class="btn small danger" data-act="del">מחיקה</button>'}</div></td>
          </tr><tr class="detail" data-d="${esc(u.user_id)}" hidden><td colspan="7"></td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="panel"><h2>גיבוי והשהיה</h2><p class="muted" style="margin:0">כדאי להוריד גיבוי מלא מדי פעם, ובמיוחד לפני חופשה ארוכה. הגיבוי כולל את רשימת המשתמשים ואת כל ההתקדמות (בלי הקודים האישיים).</p></div>
    </div>`;
    $('#a-save').onclick = async () => {
      try { await Api.adminSetSettings(session.token, $('#a-code').value, parseInt($('#a-max').value, 10)); toast('ההגדרות נשמרו'); }
      catch (e) { toast(e.code === 'BAD_CLASS_CODE' ? 'קוד הכיתה צריך להיות לפחות 4 תווים' : errText(e)); }
    };
    const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
    const stamp = () => new Date().toISOString().slice(0, 10);
    $('#a-backup').onclick = async () => { try { const d = await Api.adminExport(session.token); download(`persian-backup-${stamp()}.json`, JSON.stringify(d, null, 1), 'application/json'); } catch (e) { toast(errText(e)); } };
    $('#a-csv').onclick = () => {
      const q = v => '"' + String(v).replace(/"/g, '""') + '"';
      const lines = [['שם', 'ידועות', 'בלמידה', 'תשובות', 'נרשם', 'פעיל לאחרונה'].map(q).join(',')]
        .concat(users.map(u => [u.name, u.known, u.learning, u.answers, fmtDate(u.created_at), fmtDate(u.last_seen)].map(q).join(',')));
      download(`persian-users-${stamp()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
    };
    $$('[data-act]', el).forEach(b => b.onclick = async () => {
      const tr = b.closest('tr'), id = tr.dataset.u, u = users.find(x => x.user_id === id), cell = tr.lastElementChild;
      if (b.dataset.act === 'unlock') {
        try { await Api.adminUnlockUser(session.token, id); toast(`הנעילה של ${u.name} בוטלה. אפשר להיכנס עכשיו עם הקוד האישי.`); renderAdmin(el); } catch (e) { toast(errText(e)); }
      } else if (b.dataset.act === 'detail') {
        const d = $(`tr[data-d="${CSS.escape(id)}"]`, el);
        if (!d.hidden) { d.hidden = true; return; }
        d.hidden = false; d.firstElementChild.innerHTML = '<span class="muted">טוען…</span>';
        try {
          const rows = await Api.adminUserProgress(session.token, id);
          const m = new Map(rows.map(r => [r.item_id, r.status]));
          d.firstElementChild.innerHTML = progressBars(i => m.get(i) || 0);
        } catch (e) { d.firstElementChild.innerHTML = `<span class="err">${esc(errText(e))}</span>`; }
      } else if (b.dataset.act === 'pin') {
        cell.innerHTML = `<form class="confirm" id="pinform"><input type="text" inputmode="numeric" maxlength="4" placeholder="4 ספרות" style="width:90px" aria-label="קוד חדש"><button class="btn small primary">שמור</button><button class="btn small" type="button" id="pin-cancel">ביטול</button></form>`;
        $('#pin-cancel', cell).onclick = () => renderAdmin(el);
        $('#pinform', cell).onsubmit = async ev => {
          ev.preventDefault(); const pin = $('input', cell).value.trim();
          try { await Api.adminResetPin(session.token, id, pin); toast(`הקוד של ${u.name} עודכן. צריך למסור את הקוד החדש למשתמש.`); renderAdmin(el); } catch (e) { toast(errText(e)); }
        };
        $('input', cell).focus();
      } else if (b.dataset.act === 'del') {
        cell.innerHTML = `<span class="confirm"><span>למחוק את ${esc(u.name)} ואת כל ההתקדמות שלו?</span><button class="btn small danger" id="del-yes">כן, למחוק</button><button class="btn small" id="del-no">ביטול</button></span>`;
        $('#del-no', cell).onclick = () => renderAdmin(el);
        $('#del-yes', cell).onclick = async () => { try { await Api.adminDeleteUser(session.token, id); toast('המשתמש נמחק'); renderAdmin(el); } catch (e) { toast(errText(e)); } };
      }
    });
  }

  // ---------- boot ----------
  (async function boot() {
    if (!session) return route();   // visitors land on the site as guests
    try {
      const me = await Api.whoami(session.token);
      session.name = me.name; session.is_admin = !!me.is_admin; ls.set('fa-session', session);
      await loadProgress();
      route();
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED') { session = null; ls.del('fa-session'); go('#login', false); return renderLogin(ERR.SESSION_EXPIRED, 'login'); }
      app.innerHTML = `<div class="login panel"><h2>אי אפשר להתחבר כרגע</h2><p>${esc(errText(e))}</p><button class="btn primary" onclick="location.reload()">נסה שוב</button></div>`;
    }
  })();
})();
