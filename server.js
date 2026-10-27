const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency). Values stay in the file, never in code.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) {}

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const ON_VERCEL = !!process.env.VERCEL;
const BASE_URL = (process.env.BASE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${PORT}`)).replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // local file mode only
const DB_FILE = path.join(DATA_DIR, 'db.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'outbox.json');
const MIN_PARTICIPANTS = 2; // 2 works (A gets B, B gets A). Raise to 3 for real use.

if (!DATABASE_URL) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {} }

// ---------- storage ----------
// Postgres (DATABASE_URL, e.g. Neon): the whole state is one JSONB row. Every API request reads it fresh;
// write requests lock the row (SELECT ... FOR UPDATE) until they commit, so several server instances
// (serverless) can never overwrite each other. Without DATABASE_URL: local JSON file, in memory (single process).
let fileDb = { events: {} };
let pool = null;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, max: 5, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
  pool.on('error', (e) => console.error('[pg idle client]', e.message));
}

let schemaReady = null;
const ensureSchema = () => schemaReady || (schemaReady = (async () => {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    await pool.query(`INSERT INTO kv (key, value) VALUES ('db', '{"events":{}}') ON CONFLICT (key) DO NOTHING`);
  } else {
    try { fileDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) {}
  }
})().catch((e) => { schemaReady = null; throw e; }));

let fileChain = Promise.resolve();
const saveFile = () => {
  const snapshot = JSON.stringify(fileDb, null, 2);
  fileChain = fileChain.catch(() => {}).then(() => fs.promises.writeFile(DB_FILE, snapshot));
  return fileChain;
};

// Gives each /api request req.db (its own copy of the state), req.commit() (persist) and req.release() (drop the lock early).
async function openScope(req, res, next) {
  try {
    await ensureSchema();
    if (!pool) { req.db = fileDb; req.commit = saveFile; req.release = async () => {}; return next(); }
    if (req.method === 'GET' || req.method === 'HEAD') {
      req.db = (await pool.query("SELECT value FROM kv WHERE key = 'db'")).rows[0].value;
      req.commit = async () => {}; req.release = async () => {};
      return next();
    }
    const client = await pool.connect();
    let done = false;
    const finish = async (sql) => { if (done) return; done = true; try { await client.query(sql); } finally { client.release(); } };
    try {
      await client.query('BEGIN');
      req.db = (await client.query("SELECT value FROM kv WHERE key = 'db' FOR UPDATE")).rows[0].value;
    } catch (e) { await finish('ROLLBACK').catch(() => {}); throw e; }
    req.commit = async () => {
      if (done) return;
      await client.query("UPDATE kv SET value = $1::jsonb, updated_at = now() WHERE key = 'db'", [JSON.stringify(req.db)]);
      await finish('COMMIT');
    };
    req.release = () => finish('ROLLBACK').catch(() => {});
    res.on('close', () => { finish('ROLLBACK').catch(() => {}); }); // never leave the lock held if a handler exits without committing
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
}
const uid = (n = 16) => crypto.randomBytes(n).toString('hex');

// ---------- mail ----------
const mailEnabled = !!(process.env.SMTP_USER && process.env.SMTP_APP_PASSWORD);
const transport = mailEnabled
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_APP_PASSWORD },
    })
  : null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendMail({ to, subject, html, text }) {
  if (!mailEnabled) {
    try {
      let box = [];
      try { box = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8')); } catch (_) {}
      box.push({ at: new Date().toISOString(), to, subject, text });
      fs.writeFileSync(OUTBOX_FILE, JSON.stringify(box, null, 2));
    } catch (_) {}
    console.log(`[mail:dry-run] to=${to} subject="${subject}"`);
    return { sent: false };
  }
  await transport.sendMail({ from: `Secret Santa <${process.env.SMTP_USER}>`, to, subject, html, text });
  console.log(`[mail:sent] to=${to} subject="${subject}"`);
  return { sent: true };
}

// Sends a batch, logs failures, returns how many failed.
async function sendAll(mails) {
  const results = await Promise.allSettled(mails.map(sendMail));
  results.forEach((r, i) => { if (r.status === 'rejected') console.error(`[mail:failed] to=${mails[i].to}: ${r.reason && r.reason.message}`); });
  return results.filter((r) => r.status === 'rejected').length;
}

const shell = (inner) => `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#202020">${inner}</div>`;
const button = (href, label) => `<p><a href="${esc(href)}" style="display:inline-block;background:#234BED;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600">${esc(label)}</a></p>`;
const link = (p) => `${BASE_URL}/?t=${p.token}`;

function inviteMail(ev, host, p) {
  const subject = `${host.name} invited you to Secret Santa: ${ev.name}`;
  const text = `${host.name} invited you to "${ev.name}".${ev.budget ? ` Budget: ${ev.budget}.` : ''}\nAdd your wishlist: ${link(p)}`;
  const html = shell(`<h2 style="margin:0 0 8px">${esc(ev.name)}</h2>
    <p>${esc(host.name)} invited you to a Secret Santa.${ev.budget ? ` Budget: <b>${esc(ev.budget)}</b>.` : ''}</p>
    <p>Add what you would like (name and link per item), then press Save and send.</p>${button(link(p), 'Add my wishlist')}
    <p style="color:#646464;font-size:13px">This link is personal. Do not forward it.</p>`);
  return { to: p.email, subject, html, text };
}

function hostMail(ev, host) {
  const subject = `Your host link: ${ev.name}`;
  const text = `You created "${ev.name}". This is your personal host link. Keep it, it is the only way back in:\n${link(host)}`;
  const html = shell(`<h2 style="margin:0 0 8px">${esc(ev.name)}</h2><p>You created this Secret Santa. This is your personal host link. Keep this email, it is the only way back in.</p>${button(link(host), 'Open host view')}`);
  return { to: host.email, subject, html, text };
}

function assignmentMail(ev, giver, giftee) {
  const items = giftee.wishlist;
  const subject = `Your Secret Santa: ${giftee.name} (${ev.name})`;
  const text = `You are Secret Santa for ${giftee.name}.\n\nTheir list:\n${items.map((i, n) => `${n + 1}. ${i.name}${i.link ? ` - ${i.link}` : ''}`).join('\n')}\n\n${link(giver)}`;
  const html = shell(`<h2 style="margin:0 0 8px">You are Secret Santa for ${esc(giftee.name)}</h2>
    ${ev.budget ? `<p>Budget: <b>${esc(ev.budget)}</b></p>` : ''}
    <ol style="padding-left:20px">${items.map((i) => `<li style="margin:6px 0">${esc(i.name)}${i.link ? ` <a href="${esc(i.link)}" style="color:#234BED">link</a>` : ''}</li>`).join('')}</ol>
    ${button(link(giver), 'Open in app')}<p style="color:#646464;font-size:13px">Keep it secret.</p>`);
  return { to: giver.email, subject, html, text };
}

// ---------- helpers ----------
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanEmails = (arr) => [...new Set((arr || []).map((e) => String(e).trim().toLowerCase()).filter((e) => emailRe.test(e)))];
const nameFromEmail = (e) => e.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function normaliseLink(l) {
  l = String(l || '').trim();
  if (!l) return '';
  if (!/^https?:\/\//i.test(l)) l = 'https://' + l;
  try { const u = new URL(l); return /^https?:$/.test(u.protocol) ? u.toString() : ''; } catch (_) { return ''; }
}

function findByToken(db, token) {
  for (const ev of Object.values(db.events)) {
    const p = ev.participants.find((x) => x.token === token);
    if (p) return { ev, p };
  }
  return null;
}

function notify(p, title, body) {
  p.notifications.push({ id: uid(6), at: Date.now(), title, body, read: false });
}

function derange(ids) {
  for (let tries = 0; tries < 1000; tries++) {
    const t = [...ids];
    for (let i = t.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [t[i], t[j]] = [t[j], t[i]];
    }
    if (t.every((x, i) => x !== ids[i])) return t;
  }
  throw new Error('derangement failed');
}

function addParticipants(ev, emails) {
  const existing = new Set(ev.participants.map((p) => p.email));
  const added = [];
  for (const email of cleanEmails(emails)) {
    if (existing.has(email)) continue;
    const p = { id: uid(6), token: uid(18), email, name: nameFromEmail(email), isHost: false, submitted: false, wishlist: [], assignedToId: null, notifications: [] };
    ev.participants.push(p);
    added.push(p);
  }
  return added;
}

// ---------- app ----------
const app = express();
if (process.env.TRUST_PROXY || ON_VERCEL) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1); // behind a host's proxy, so rate limiting sees real IPs
app.use(express.json({ limit: '100kb' }));

// Tiny in-memory rate limiter (single process).
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const key = req.ip + '|' + req.path;
  const now = Date.now();
  const rec = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (rec.length >= max) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  rec.push(now); hits.set(key, rec); next();
};
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k); }, 60000).unref();
app.use('/api', limit(240, 60000));
app.get('/api/config', (_req, res) => res.json({ mailEnabled }));
app.use('/api', openScope);
const mailLimit = limit(15, 60000);
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  const found = findByToken(req.db, req.get('x-token') || '');
  if (!found) return res.status(401).json({ error: 'Invalid link' });
  req.ev = found.ev; req.p = found.p;
  next();
};
const hostOnly = (req, res, next) => (req.p.isHost ? next() : res.status(403).json({ error: 'Host only' }));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error' }); });

app.post('/api/events', mailLimit, wrap(async (req, res) => {
  const { name, budget, hostName, hostEmail, emails } = req.body || {};
  const hEmail = cleanEmails([hostEmail])[0];
  if (!String(name || '').trim() || !String(hostName || '').trim() || !hEmail) return res.status(400).json({ error: 'Event name, your name and a valid email are required' });
  const ev = { id: uid(6), name: String(name).trim().slice(0, 80), budget: String(budget || '').trim().slice(0, 40), status: 'collecting', participants: [], createdAt: Date.now() };
  const host = { id: uid(6), token: uid(18), email: hEmail, name: String(hostName).trim().slice(0, 60), isHost: true, submitted: false, wishlist: [], assignedToId: null, notifications: [] };
  ev.participants.push(host);
  const invitees = addParticipants(ev, (emails || []).filter((e) => String(e).trim().toLowerCase() !== hEmail));
  req.db.events[ev.id] = ev; await req.commit();
  const failed = await sendAll([hostMail(ev, host), ...invitees.map((p) => inviteMail(ev, host, p))]);
  res.json({ token: host.token, invited: invitees.length, mail: { enabled: mailEnabled, failed } });
}));

function view(ev, me) {
  const byId = Object.fromEntries(ev.participants.map((p) => [p.id, p]));
  const out = {
    event: { name: ev.name, budget: ev.budget, status: ev.status },
    me: { name: me.name, email: me.email, isHost: me.isHost, submitted: me.submitted, wishlist: me.wishlist },
    notifications: [...me.notifications].reverse(),
    assignment: null,
  };
  if (ev.status === 'assigned' && me.assignedToId) {
    const g = byId[me.assignedToId];
    out.assignment = { name: g.name, wishlist: g.wishlist };
  }
  if (me.isHost) {
    out.participants = ev.participants.map((p) => ({ id: p.id, name: p.name, email: p.email, isHost: p.isHost, submitted: p.submitted, items: p.wishlist.length }));
    out.canDraw = ev.status === 'collecting' && ev.participants.length >= MIN_PARTICIPANTS && ev.participants.every((p) => p.submitted);
    out.minParticipants = MIN_PARTICIPANTS;
  }
  return out;
}

app.get('/api/me', auth, (req, res) => res.json(view(req.ev, req.p)));

app.post('/api/me/wishlist', auth, wrap(async (req, res) => {
  const { ev, p } = req;
  if (ev.status !== 'collecting') return res.status(409).json({ error: 'Names are already drawn' });
  const name = String(req.body.name || '').trim().slice(0, 60);
  const items = (Array.isArray(req.body.items) ? req.body.items : [])
    .map((i) => ({ name: String(i.name || '').trim().slice(0, 120), link: normaliseLink(i.link) }))
    .filter((i) => i.name || i.link)
    .map((i) => ({ ...i, name: i.name || i.link }))
    .slice(0, 50);
  if (!items.length) return res.status(400).json({ error: 'Add at least one item' });
  if (name) p.name = name;
  p.wishlist = items; p.submitted = true;
  const host = ev.participants.find((x) => x.isHost);
  if (!p.isHost) notify(host, `${p.name} sent their list`, `${items.length} item${items.length === 1 ? '' : 's'}`);
  await req.commit();
  res.json(view(ev, p));
}));

app.post('/api/event/invite', mailLimit, auth, hostOnly, wrap(async (req, res) => {
  const { ev, p: host } = req;
  if (ev.status !== 'collecting') return res.status(409).json({ error: 'Names are already drawn' });
  const added = addParticipants(ev, req.body.emails);
  await req.commit();
  const failed = await sendAll(added.map((x) => inviteMail(ev, host, x)));
  res.json({ ...view(ev, host), mail: { enabled: mailEnabled, failed, count: added.length } });
}));

app.post('/api/event/remind', mailLimit, auth, hostOnly, wrap(async (req, res) => {
  const { ev, p: host } = req;
  await req.release();
  const pending = ev.participants.filter((x) => !x.submitted && !x.isHost);
  const failed = await sendAll(pending.map((x) => inviteMail(ev, host, x)));
  res.json({ reminded: pending.length, mail: { enabled: mailEnabled, failed } });
}));

app.post('/api/event/remove', auth, hostOnly, wrap(async (req, res) => {
  const { ev, p: host } = req;
  if (ev.status !== 'collecting') return res.status(409).json({ error: 'Names are already drawn' });
  const target = ev.participants.find((x) => x.id === req.body.id);
  if (!target) return res.status(404).json({ error: 'Person not found' });
  if (target.isHost) return res.status(400).json({ error: 'You cannot remove yourself' });
  ev.participants = ev.participants.filter((x) => x !== target);
  await req.commit();
  res.json(view(ev, host));
}));

app.post('/api/event/resend', mailLimit, auth, hostOnly, wrap(async (req, res) => {
  const { ev, p: host } = req;
  const target = ev.participants.find((x) => x.id === req.body.id);
  if (!target || target.isHost) return res.status(404).json({ error: 'Person not found' });
  const mail = ev.status === 'assigned' && target.assignedToId
    ? assignmentMail(ev, target, ev.participants.find((x) => x.id === target.assignedToId))
    : inviteMail(ev, host, target);
  await req.release();
  const failed = await sendAll([mail]);
  res.json({ mail: { enabled: mailEnabled, failed } });
}));

app.post('/api/event/delete', auth, hostOnly, wrap(async (req, res) => {
  delete req.db.events[req.ev.id];
  await req.commit();
  res.json({ ok: true });
}));

app.post('/api/event/draw', auth, hostOnly, wrap(async (req, res) => {
  const { ev, p: host } = req;
  if (ev.status !== 'collecting') return res.status(409).json({ error: 'Already drawn' });
  if (ev.participants.length < MIN_PARTICIPANTS) return res.status(400).json({ error: `Need at least ${MIN_PARTICIPANTS} people` });
  if (!ev.participants.every((x) => x.submitted)) return res.status(400).json({ error: 'Not everyone has sent their list' });
  const ids = ev.participants.map((x) => x.id);
  const targets = derange(ids);
  ev.participants.forEach((x, i) => { x.assignedToId = targets[i]; });
  ev.status = 'assigned';
  const byId = Object.fromEntries(ev.participants.map((x) => [x.id, x]));
  for (const giver of ev.participants) {
    const g = byId[giver.assignedToId];
    notify(giver, `You are Secret Santa for ${g.name}`, `${g.wishlist.length} item${g.wishlist.length === 1 ? '' : 's'} on their list`);
  }
  await req.commit();
  const failed = await sendAll(ev.participants.map((giver) => assignmentMail(ev, giver, byId[giver.assignedToId])));
  res.json({ ...view(ev, host), mail: { enabled: mailEnabled, failed } });
}));

app.post('/api/me/notifications/read', auth, wrap(async (req, res) => {
  req.p.notifications.forEach((n) => { n.read = true; });
  await req.commit();
  res.json({ ok: true });
}));

if (require.main === module) {
  ensureSchema().then(() => app.listen(PORT, () => {
    console.log(`Secret Santa on ${BASE_URL}`);
    console.log(pool ? 'Storage: Postgres' : 'Storage: local JSON file (data/db.json)');
    console.log(mailEnabled ? `Email: sending via ${process.env.SMTP_USER}` : 'Email: DRY RUN (set SMTP_USER and SMTP_APP_PASSWORD to send). Messages are written to data/outbox.json');
  })).catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
}

module.exports = app; // Vercel runs the exported app; locally `node server.js` listens
