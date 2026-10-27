(() => {
  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const params = new URLSearchParams(location.search);
  let token = params.get('t') || safeGet('ss_token');
  let data = null;
  let rows = null;            // wishlist inputs, kept across re-renders
  let displayName = '';
  let createEmails = [];
  let inviteEmails = [];
  let seenNotifs = null;
  let busy = false;

  function safeGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-token': token || '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Something went wrong');
    return json;
  }

  let toastTimer;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast glass' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3600);
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Honest status: says so when email is not configured or failed.
  function mailMsg(mail, okText) {
    if (!mail || !mail.enabled) return 'Email not configured: nothing was sent (see data/outbox.json)';
    if (mail.failed) return `${mail.failed} email(s) failed to send. Check the server terminal`;
    return okText;
  }

  // ---------- email chip input ----------
  function emailInput(list, onChange, placeholder = 'name@company.com') {
    const wrap = h('div');
    const chips = h('div', { class: 'chips' });
    const input = h('input', { type: 'email', placeholder, autocomplete: 'off', inputmode: 'email' });
    const err = h('div', { class: 'error', hidden: true });
    const draw = () => {
      chips.replaceChildren(...list.map((e, i) => h('span', { class: 'chip' }, e,
        h('button', { type: 'button', 'aria-label': 'Remove ' + e, onclick: () => { list.splice(i, 1); draw(); onChange && onChange(); } }, '×'))));
    };
    const add = () => {
      const parts = input.value.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!parts.length) return true;
      const bad = parts.filter((p) => !emailRe.test(p));
      parts.filter((p) => emailRe.test(p) && !list.includes(p)).forEach((p) => list.push(p));
      input.value = bad.join(' ');
      err.hidden = !bad.length; err.textContent = bad.length ? 'Not a valid email: ' + bad.join(', ') : '';
      draw(); onChange && onChange();
      return !bad.length;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } });
    input.addEventListener('blur', add);
    input.addEventListener('paste', () => setTimeout(add, 0));
    wrap.append(h('div', { class: 'addrow' }, input, h('button', { class: 'btn ghost small', type: 'button', onclick: add }, 'Add')), err, chips);
    draw();
    wrap.flush = add;
    return wrap;
  }

  // ---------- views ----------
  function viewCreate() {
    $('#topbar').hidden = true;
    const f = { name: '', budget: '', hostName: '', hostEmail: '' };
    const field = (key, label, ph, type = 'text') => [
      h('label', { class: 'label' }, label),
      h('input', { type, placeholder: ph, oninput: (e) => (f[key] = e.target.value) }),
    ];
    const emails = emailInput(createEmails, null);
    const err = h('div', { class: 'error', hidden: true });
    const btn = h('button', { class: 'btn block', style: 'margin-top:20px', onclick: async () => {
      if (!emails.flush()) return;
      btn.disabled = true; err.hidden = true;
      try {
        const r = await api('/api/events', { ...f, emails: createEmails });
        token = r.token; safeSet('ss_token', token);
        history.replaceState(null, '', '?t=' + token);
        toast(mailMsg(r.mail, `Invites emailed to ${r.invited} ${r.invited === 1 ? 'person' : 'people'}`));
        await load();
      } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; }
    } }, 'Create and send invites');
    app.replaceChildren(
      h('section', { class: 'card glass' },
        h('div', { style: 'font-size:44px' }, '🎁'),
        h('h1', {}, 'Secret Santa'),
        h('p', { class: 'sub' }, 'Invite people by email. Everyone adds a wishlist. You draw the names.'),
        field('name', 'Event name', 'Design team 2026'),
        field('budget', 'Budget (optional)', '€25'),
        h('div', { class: 'row2' }, h('div', {}, ...field('hostName', 'Your name', 'Benni')), h('div', {}, ...field('hostEmail', 'Your email', 'you@company.com', 'email'))),
        h('label', { class: 'label' }, 'Invite people (at least 1 other)'),
        emails, err, btn,
        h('p', { class: 'hint' }, 'You take part too. Press Enter or comma after each address, or paste a list.')
      )
    );
  }

  function wishlistCard() {
    const me = data.me;
    if (!rows) {
      rows = me.wishlist.length ? me.wishlist.map((w) => ({ name: w.name, link: w.link })) : Array.from({ length: 5 }, () => ({ name: '', link: '' }));
      displayName = me.name;
    }
    const items = h('div', { class: 'items' });
    const drawRows = () => {
      items.replaceChildren(...rows.map((r, i) => h('div', { class: 'item' },
        h('span', { class: 'n' }, i + 1),
        h('input', { placeholder: 'Item name', value: r.name, 'aria-label': `Item ${i + 1} name`, oninput: (e) => (r.name = e.target.value) }),
        h('input', { placeholder: 'Link (optional)', type: 'url', inputmode: 'url', value: r.link, 'aria-label': `Item ${i + 1} link`, oninput: (e) => (r.link = e.target.value) }))));
    };
    drawRows();
    return h('section', { class: 'card glass' },
      h('h2', {}, me.submitted ? 'Your wishlist (sent)' : 'Your wishlist'),
      h('p', { class: 'sub' }, data.event.budget ? `Budget: ${data.event.budget}. ` + 'Add what you would like, with a link if you have one.' : 'Add what you would like, with a link if you have one.'),
      h('label', { class: 'label' }, 'Your name'),
      h('input', { value: displayName, oninput: (e) => (displayName = e.target.value) }),
      h('label', { class: 'label' }, 'Items'),
      items,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
        rows.push({ name: '', link: '' }); drawRows();
        items.lastChild.querySelector('input').focus();
      } }, '+ Add item')),
    );
  }

  function hostCard() {
    const ps = data.participants;
    const done = ps.filter((p) => p.submitted).length;
    const emails = emailInput(inviteEmails, null);
    const drawBtn = h('button', { class: 'btn', disabled: !data.canDraw, onclick: async () => {
      if (!confirm('Draw names now? This cannot be undone and emails everyone their match.')) return;
      drawBtn.disabled = true;
      try { const r = await api('/api/event/draw', {}); data = r; toast(mailMsg(r.mail, 'Names drawn. Everyone has been emailed.')); render(); }
      catch (e) { toast(e.message, true); drawBtn.disabled = false; }
    } }, 'Draw names');
    const needed = ps.length < data.minParticipants ? `Need at least ${data.minParticipants} people.` : done < ps.length ? `Waiting for ${ps.length - done} more.` : 'Everyone has sent their list.';
    return h('section', { class: 'card glass' },
      h('h2', {}, 'Host controls'),
      h('p', { class: 'sub' }, `${done} of ${ps.length} lists received`),
      h('div', { class: 'progress' }, h('i', { style: `width:${ps.length ? (done / ps.length) * 100 : 0}%` })),
      h('div', { class: 'people' }, ps.map((p) => h('div', { class: 'person' },
        h('div', { class: 'who' }, h('b', {}, p.name + (p.isHost ? ' (you)' : '')), h('small', {}, p.email)),
        h('div', { class: 'pbtns' },
          h('span', { class: 'pill ' + (p.submitted ? 'ok' : 'wait') }, p.submitted ? `${p.items} item${p.items === 1 ? '' : 's'}` : 'Waiting'),
          !p.isHost && h('button', { class: 'mini', type: 'button', title: 'Resend email', 'aria-label': 'Resend email to ' + p.email, onclick: async () => {
            try { const r = await api('/api/event/resend', { id: p.id }); toast(mailMsg(r.mail, 'Email sent to ' + p.email)); } catch (e) { toast(e.message, true); }
          } }, '↻'),
          !p.isHost && data.event.status === 'collecting' && h('button', { class: 'mini danger', type: 'button', title: 'Remove', 'aria-label': 'Remove ' + p.email, onclick: async () => {
            if (!confirm(`Remove ${p.name} from this event?`)) return;
            try { data = await api('/api/event/remove', { id: p.id }); render(); } catch (e) { toast(e.message, true); }
          } }, '×'))))),
      h('label', { class: 'label' }, 'Invite more people'),
      emails,
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost small', onclick: async () => {
          if (!emails.flush() || !inviteEmails.length) return;
          try { const r = await api('/api/event/invite', { emails: inviteEmails }); data = r; inviteEmails.length = 0; toast(mailMsg(r.mail, 'Invites emailed')); render(); } catch (e) { toast(e.message, true); }
        } }, 'Send invites'),
        h('button', { class: 'btn ghost small', onclick: async () => {
          try { const r = await api('/api/event/remind', {}); toast(mailMsg(r.mail, `Reminded ${r.reminded} ${r.reminded === 1 ? 'person' : 'people'}`)); } catch (e) { toast(e.message, true); }
        } }, 'Remind pending')),
      h('div', { class: 'actions', style: 'margin-top:20px' }, drawBtn),
      h('p', { class: 'hint' }, needed),
      deleteBtn()
    );
  }

  function deleteBtn() {
    return h('div', { class: 'actions' }, h('button', { class: 'btn ghost small danger-text', type: 'button', onclick: async () => {
      if (!confirm('Delete this event for everyone? This cannot be undone.')) return;
      try {
        await api('/api/event/delete', {});
        token = null; data = null; rows = null; safeSet('ss_token', '');
        history.replaceState(null, '', location.pathname);
        document.querySelector('.dock')?.remove();
        toast('Event deleted'); render();
      } catch (e) { toast(e.message, true); }
    } }, 'Delete event'));
  }

  function assignmentCards() {
    const a = data.assignment;
    const cards = [
      h('section', { class: 'card glass reveal' },
        h('div', { class: 'tag' }, 'You are Secret Santa for'),
        h('div', { class: 'big' }, a.name),
        data.event.budget && h('p', { class: 'sub', style: 'margin:0' }, `Budget: ${data.event.budget}`)),
      h('section', { class: 'card glass' },
        h('h2', {}, `${a.name}'s wishlist`),
        a.wishlist.map((w) => h('div', { class: 'wish' }, h('span', {}, w.name), w.link && h('a', { href: w.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open'))),
        h('p', { class: 'hint' }, 'A copy was emailed to you. Keep it secret.')),
    ];
    return cards;
  }

  function viewApp() {
    const topbar = $('#topbar');
    topbar.hidden = false;
    $('#eventTitle').textContent = data.event.name;
    const assigned = data.event.status === 'assigned';
    const out = [];
    if (assigned) {
      if (data.assignment) out.push(...assignmentCards());
      if (data.me.isHost) out.push(h('section', { class: 'card glass' }, h('h2', {}, 'Names drawn'), h('p', { class: 'sub', style: 'margin:0' }, 'Everyone received their match by email and in the app. Matches are hidden from you too, except your own.'), deleteBtn()));
    } else {
      if (data.me.isHost) out.push(hostCard());
      else if (data.me.submitted) out.push(h('section', { class: 'card glass' }, h('h2', {}, 'List sent ✓'), h('p', { class: 'sub', style: 'margin:0' }, 'Waiting for everyone else. You will get an email and a notification here when names are drawn. You can still edit your list below.')));
      out.push(wishlistCard());
    }
    app.replaceChildren(...out);

    document.querySelector('.dock')?.remove();
    if (!assigned) {
      const btn = h('button', { class: 'btn', onclick: saveAndSend }, data.me.submitted ? 'Update and send' : 'Save and send');
      document.body.append(h('div', { class: 'dock glass' }, btn));
    }
    updateBell();
  }

  async function saveAndSend(e) {
    if (busy) return;
    const btn = e.currentTarget;
    busy = true; btn.disabled = true;
    try {
      data = await api('/api/me/wishlist', { name: displayName, items: rows });
      rows = null;
      toast('List saved and sent ✓');
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) { toast(err.message, true); }
    busy = false; btn.disabled = false;
  }

  // ---------- notifications ----------
  function updateBell() {
    const unread = data ? data.notifications.filter((n) => !n.read).length : 0;
    $('#bellDot').hidden = !unread;
  }
  function openSheet() {
    const list = $('#notifList');
    list.replaceChildren(...(data.notifications.length
      ? data.notifications.map((n) => h('div', { class: 'notif' + (n.read ? '' : ' unread') }, h('b', {}, n.title), h('small', {}, `${n.body} · ${new Date(n.at).toLocaleString()}`)))
      : [h('p', { class: 'sub' }, 'Nothing yet.')]));
    $('#sheet').hidden = false; $('#sheetBackdrop').hidden = false;
    if (data.notifications.some((n) => !n.read)) {
      api('/api/me/notifications/read', {}).then(() => { data.notifications.forEach((n) => (n.read = true)); updateBell(); }).catch(() => {});
    }
  }
  const closeSheet = () => { $('#sheet').hidden = true; $('#sheetBackdrop').hidden = true; };
  $('#bellBtn').addEventListener('click', () => ($('#sheet').hidden ? openSheet() : closeSheet()));
  $('#sheetBackdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // ---------- load / poll ----------
  function render() {
    if (!token) { document.querySelector('.dock')?.remove(); return viewCreate(); }
    if (!data) return;
    viewApp();
  }

  function announceNew(prev, next) {
    if (!prev) return;
    const ids = new Set(prev.map((n) => n.id));
    const fresh = next.filter((n) => !ids.has(n.id));
    if (fresh.length) toast(fresh[0].title);
  }

  async function load(silent) {
    try {
      const next = await api('/api/me');
      const prevNotifs = seenNotifs;
      const statusChanged = data && data.event.status !== next.event.status;
      data = next; seenNotifs = next.notifications;
      announceNew(prevNotifs, next.notifications);
      const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
      if (!silent || statusChanged || (!typing && next.me.isHost)) render(); else updateBell();
    } catch (e) {
      if (!silent) { token = null; safeSet('ss_token', ''); history.replaceState(null, '', location.pathname); toast('That link is not valid', true); render(); }
    }
  }

  setInterval(() => { if (token && data && !document.hidden) load(true); }, 8000);
  if (token) load().then(() => { if (token) safeSet('ss_token', token); });
  else render();
})();
