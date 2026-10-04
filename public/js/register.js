(function () {
  const cfgEl = document.getElementById('register-config');
  if (!cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent || '{}');
  const altchaOn = cfg.altchaEnabled === true;
  const I18N = cfg.i18n || {};

  // ALTCHA-Widget (self-hosted PoW) nur einhaengen, wenn aktiv. Das Modul
  // registriert das <altcha-widget>-Custom-Element; auto="onload" loest die
  // Challenge unsichtbar beim Laden. Der geloeste Wert landet als Feld `altcha`
  // in der FormData (form-assoziiertes Custom-Element).
  if (altchaOn) {
    const slot = document.getElementById('altcha-slot');
    if (slot) {
      const w = document.createElement('altcha-widget');
      // v3-Widget: `challenge` ist die SSoT fuer die Challenge — ein Wert ohne
      // fuehrende `{` wird als URL gefetcht (Antwort muss application/json sein),
      // ein JSON-String wird inline geparst. Das alte v1/v2-Attribut
      // `challengeurl` kennt dieses Build nicht (wuerde die leere Default-URL =
      // aktuelle Seite fetchen → HTML → "invalid content-type").
      w.setAttribute('challenge', '/altcha/challenge');
      w.setAttribute('name', 'altcha');
      w.setAttribute('auto', 'onload');
      slot.appendChild(w);
    }
    const s = document.createElement('script');
    s.type = 'module';
    s.src = '/vendor/altcha-3.0.11.min.js';
    document.head.appendChild(s);
  }

  const form = document.getElementById('register-form');
  const msg = document.getElementById('register-msg');
  if (!form || !msg) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    msg.hidden = true;
    msg.className = 'public-msg';

    const data = new FormData(form);
    const payload = {
      email: (data.get('email') || '').trim(),
      displayName: (data.get('displayName') || '').trim() || null,
      message: (data.get('message') || '').trim() || null,
      sourceNote: (data.get('sourceNote') || '').trim() || null,
      // Vom Server beim Ausliefern ermittelt (lib/register-source.js) und hier
      // nur durchgereicht; der POST selbst kommt immer vom eigenen Host.
      source: cfg.source || null,
      altcha: altchaOn ? (data.get('altcha') || null) : null,
    };

    try {
      const r = await fetch('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 202) {
        form.reset();
        msg.textContent = I18N.success || '';
        msg.className = 'public-msg public-msg--ok';
        msg.hidden = false;
        return;
      }
      let j = {};
      try { j = await r.json(); } catch {}
      if (r.status === 429) {
        msg.textContent = I18N.rateLimit || '';
      } else if (r.status === 400) {
        msg.textContent = j.error_code === 'EMAIL_INVALID' ? (I18N.invalid || '') : (I18N.error || '');
      } else {
        msg.textContent = I18N.error || '';
      }
      msg.className = 'public-msg public-msg--err';
      msg.hidden = false;
    } catch {
      msg.textContent = I18N.error || '';
      msg.className = 'public-msg public-msg--err';
      msg.hidden = false;
    }
  });
}());
