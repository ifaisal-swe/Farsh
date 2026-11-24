/* Login page (no inline script: the CSP only allows same-origin scripts). The session cookie is
 * HttpOnly — this page never sees or stores it. */
(function () {
  'use strict';
  const KEY = 'terminal.lang';
  const TXT = {
    ar: {
      brand: 'فرصة — منصة التداول الذكية', paper: 'تداول ورقي فقط — لا توجد أموال أو أوامر حقيقية', password: 'كلمة المرور', submit: 'دخول',
      note: 'إغلاق هذه الصفحة لا يوقف المراقبة أو التداول الورقي على الخادم.', wrong: 'كلمة المرور غير صحيحة.',
      wait: 'محاولات كثيرة. أعد المحاولة بعد {s} ثانية.', fail: 'تعذر تسجيل الدخول: {e}', busy: 'جارٍ التحقق…', title: 'تسجيل الدخول — فرصة',
    },
    en: {
      brand: 'Forsah — AI Trading Terminal', paper: 'Paper trading only — no real money or orders', password: 'Password', submit: 'Sign in',
      note: 'Closing this page does not stop monitoring or paper trading on the server.', wrong: 'Wrong password.',
      wait: 'Too many attempts. Try again in {s} s.', fail: 'Sign-in failed: {e}', busy: 'Checking…', title: 'Sign in — Forsah',
    },
  };
  let lang = 'ar';
  try { const v = localStorage.getItem(KEY); if (v === 'en' || v === 'ar') lang = v; } catch { /* storage unavailable */ }
  const $ = (id) => document.getElementById(id);
  const t = (k, p = {}) => TXT[lang][k].replace(/\{(\w+)\}/g, (_, n) => p[n]);
  function apply() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('title');
    document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
    $('lang-ar').classList.toggle('active', lang === 'ar');
    $('lang-en').classList.toggle('active', lang === 'en');
  }
  function setLang(l) { lang = l; try { localStorage.setItem(KEY, l); } catch { /* ignore */ } apply(); }
  $('lang-ar').addEventListener('click', () => setLang('ar'));
  $('lang-en').addEventListener('click', () => setLang('en'));
  apply();

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('msg');
    const btn = $('submit');
    msg.textContent = t('busy');
    btn.disabled = true;
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' },
        body: JSON.stringify({ password: $('password').value }),
      });
      if (r.ok) { location.replace('/'); return; }
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) msg.textContent = t('wait', { s: j.retryAfterSec || 60 });
      else if (r.status === 401) msg.textContent = t('wrong');
      else msg.textContent = t('fail', { e: j.error || r.status });
      $('password').select();
    } catch (err) {
      msg.textContent = t('fail', { e: err.message });
    } finally { btn.disabled = false; }
  });
})();
