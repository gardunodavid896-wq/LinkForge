'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'links.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 16 * 1024;
const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const BLOCKED = new Set(['api', 'assets', 'favicon.ico', 'health', 'robots.txt']);
const limits = new Map();
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');
let links;
try { links = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (!Array.isArray(links)) throw Error('Invalid store'); }
catch (err) { console.error('Could not read database:', err.message); process.exit(1); }
function persist() {
  const temp = DB_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(links, null, 2));
  fs.renameSync(temp, DB_FILE);
}
function send(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}
function requestBody(req) {
  return new Promise((resolve, reject) => {
    let value = '';
    req.on('data', chunk => {
      value += chunk;
      if (Buffer.byteLength(value) > MAX_BODY) { reject(Object.assign(new Error('Request too large'), {status: 413})); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(value || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), {status: 400})); } });
    req.on('error', reject);
  });
}
function validTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw.trim());
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}
function makeAlias() {
  let slug;
  do { slug = crypto.randomBytes(5).toString('base64url').slice(0, 7); }
  while (links.some(l => l.alias.toLowerCase() === slug.toLowerCase()) || BLOCKED.has(slug.toLowerCase()));
  return slug;
}
function rateLimited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = limits.get(ip) || { since: now, count: 0 };
  if (now - entry.since > 60_000) { entry.since = now; entry.count = 0; }
  entry.count++;
  limits.set(ip, entry);
  if (limits.size > 3000) for (const [key, value] of limits) if (now - value.since > 60_000) limits.delete(key);
  return entry.count > 35;
}
function publicLink(l) { return { id: l.id, alias: l.alias, url: l.url, title: l.title, clicks: l.clicks, createdAt: l.createdAt, lastClickedAt: l.lastClickedAt, daily: l.daily }; }
const TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const parsed = new URL(req.url, `http://${host}`);
    const pathname = parsed.pathname;
    if (pathname === '/api/links' && req.method === 'GET') return send(res, 200, { links: [...links].reverse().map(publicLink) });
    if (pathname === '/api/links' && req.method === 'POST') {
      if (rateLimited(req)) return send(res, 429, { error: 'Too many links created. Try again in a minute.' });
      const body = await requestBody(req);
      const url = validTarget(body.url);
      if (!url) return send(res, 400, { error: 'Enter a valid http:// or https:// URL.' });
      const custom = typeof body.alias === 'string' ? body.alias.trim() : '';
      if (custom && (!ALIAS_PATTERN.test(custom) || BLOCKED.has(custom.toLowerCase()))) return send(res, 400, { error: 'Custom code must be 3–32 letters, numbers, hyphens, or underscores.' });
      const alias = custom || makeAlias();
      if (links.some(l => l.alias.toLowerCase() === alias.toLowerCase())) return send(res, 409, { error: 'That short code is already taken.' });
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
      const entry = { id: crypto.randomUUID(), alias, url, title, clicks: 0, createdAt: new Date().toISOString(), lastClickedAt: null, daily: {} };
      links.push(entry); persist();
      return send(res, 201, { link: publicLink(entry) });
    }
    if (pathname.startsWith('/api/links/') && req.method === 'DELETE') {
      // Local single-user project. Add authentication before public multi-user deployment.
      const alias = decodeURIComponent(pathname.slice('/api/links/'.length));
      const index = links.findIndex(l => l.alias === alias);
      if (index === -1) return send(res, 404, { error: 'Link not found.' });
      links.splice(index, 1); persist(); return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname !== '/' && !pathname.includes('.') && !pathname.startsWith('/api/')) {
      const alias = decodeURIComponent(pathname.slice(1));
      const link = links.find(l => l.alias === alias);
      if (!link) return send(res, 404, { error: 'Short link not found.' });
      link.clicks += 1;
      const day = new Date().toISOString().slice(0, 10);
      link.daily[day] = (link.daily[day] || 0) + 1;
      link.lastClickedAt = new Date().toISOString(); persist();
      res.writeHead(302, { Location: link.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {error: 'Method not allowed.'});
    if (pathname.startsWith('/api/')) return send(res, 404, {error: 'API route not found.'});
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(PUBLIC_DIR, filename);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, {error: 'Forbidden.'});
    fs.readFile(file, (error, data) => {
      if (error) return send(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  } catch (err) { console.error(err); if (!res.headersSent) send(res, err.status || 500, {error: err.status ? err.message : 'Server error.'}); }
});
server.listen(PORT, HOST, () => console.log(`LinkForge ready: http://localhost:${PORT}`));
