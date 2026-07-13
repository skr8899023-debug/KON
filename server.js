#!/usr/bin/env node
/**
 * KON — مدير ملفات ذكي (Smart File Manager)
 * خادم Node.js بدون أي اعتماديات خارجية.
 * يشغّل ويعدّل ويحرّر الملفات داخل مجلد العمل (workspace) بأمان.
 *
 * التشغيل:  node server.js [--port 3000] [--root ./workspace]
 */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const url = require('url');

// ---------- الإعدادات ----------
const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = parseInt(argValue('--port', process.env.PORT || '3000'), 10);
const ROOT = path.resolve(argValue('--root', process.env.KON_ROOT || './workspace'));
const RUN_TIMEOUT_MS = 15000; // مهلة تشغيل السكربتات
const MAX_EDIT_SIZE = 2 * 1024 * 1024; // أقصى حجم ملف قابل للتحرير (2MB)

// إنشاء مجلد العمل إن لم يوجد
fs.mkdirSync(ROOT, { recursive: true });

// ---------- أدوات الأمان ----------
/** يحوّل مساراً نسبياً قادماً من المتصفح إلى مسار مطلق داخل ROOT فقط */
function safePath(rel) {
  const clean = path.normalize(rel || '').replace(/^([/\\])+/, '');
  const abs = path.resolve(ROOT, clean);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw Object.assign(new Error('مسار غير مسموح به'), { status: 403 });
  }
  return abs;
}

// ---------- أدوات HTTP ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('الحجم كبير جداً'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSONBody(req) {
  const buf = await readBody(req);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('JSON غير صالح'), { status: 400 });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};
function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// الامتدادات النصية القابلة للتحرير
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.json', '.html', '.htm', '.css', '.scss', '.less', '.xml', '.svg', '.yml',
  '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.sh', '.bash', '.zsh',
  '.py', '.rb', '.php', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go',
  '.rs', '.sql', '.csv', '.tsv', '.log', '.gitignore', '.dockerfile', '',
]);
function isTextFile(p) {
  const base = path.basename(p).toLowerCase();
  if (base === 'dockerfile' || base === 'makefile' || base.startsWith('.')) return true;
  return TEXT_EXTS.has(path.extname(p).toLowerCase());
}

// ---------- مشغّلات الملفات ----------
const RUNNERS = {
  '.js': (f) => ['node', [f]],
  '.mjs': (f) => ['node', [f]],
  '.cjs': (f) => ['node', [f]],
  '.py': (f) => ['python3', [f]],
  '.sh': (f) => ['bash', [f]],
  '.bash': (f) => ['bash', [f]],
  '.rb': (f) => ['ruby', [f]],
  '.php': (f) => ['php', [f]],
};

function runFile(abs, stdinText) {
  return new Promise((resolve) => {
    const ext = path.extname(abs).toLowerCase();
    const runner = RUNNERS[ext];
    if (!runner) {
      resolve({ ok: false, error: `لا يوجد مشغّل للامتداد "${ext || 'بدون امتداد'}"` });
      return;
    }
    const [cmd, cmdArgs] = runner(abs);
    const started = Date.now();
    let out = '';
    let err = '';
    let truncated = false;
    const LIMIT = 200 * 1024;

    const child = spawn(cmd, cmdArgs, {
      cwd: path.dirname(abs),
      env: { ...process.env },
      timeout: RUN_TIMEOUT_MS,
    });

    const collect = (setter) => (chunk) => {
      const s = chunk.toString('utf8');
      if (out.length + err.length < LIMIT) setter(s);
      else truncated = true;
    };
    child.stdout.on('data', collect((s) => (out += s)));
    child.stderr.on('data', collect((s) => (err += s)));

    if (stdinText) child.stdin.write(stdinText);
    child.stdin.end();

    child.on('error', (e) => {
      resolve({ ok: false, error: `تعذّر التشغيل: ${e.message}` });
    });
    child.on('close', (code, signal) => {
      resolve({
        ok: true,
        code,
        signal,
        stdout: out,
        stderr: err,
        truncated,
        durationMs: Date.now() - started,
        timedOut: signal === 'SIGTERM' && Date.now() - started >= RUN_TIMEOUT_MS - 100,
      });
    });
  });
}

// ---------- عمليات الملفات ----------
async function listTree(abs, rel, depth = 0) {
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, 'ar');
  });
  const result = [];
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const childAbs = path.join(abs, e.name);
    if (e.isDirectory()) {
      result.push({
        name: e.name,
        path: childRel,
        type: 'dir',
        children: depth < 12 ? await listTree(childAbs, childRel, depth + 1) : [],
      });
    } else if (e.isFile()) {
      const st = await fsp.stat(childAbs);
      result.push({
        name: e.name,
        path: childRel,
        type: 'file',
        size: st.size,
        mtime: st.mtimeMs,
        runnable: !!RUNNERS[path.extname(e.name).toLowerCase()],
        text: isTextFile(e.name),
      });
    }
  }
  return result;
}

async function searchFiles(q) {
  const results = [];
  const ql = q.toLowerCase();
  async function walk(abs, rel) {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (e.isFile()) {
        if (e.name.toLowerCase().includes(ql)) {
          results.push({ path: childRel, line: 0, preview: '(اسم الملف مطابق)' });
        }
        if (isTextFile(e.name)) {
          const st = await fsp.stat(childAbs);
          if (st.size <= MAX_EDIT_SIZE) {
            const content = await fsp.readFile(childAbs, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length && results.length < 200; i++) {
              if (lines[i].toLowerCase().includes(ql)) {
                results.push({ path: childRel, line: i + 1, preview: lines[i].trim().slice(0, 160) });
              }
            }
          }
        }
      }
      if (results.length >= 200) return;
    }
  }
  await walk(ROOT, '');
  return results;
}

// ---------- الموجّه (Router) ----------
async function handleAPI(req, res, parsed) {
  const route = parsed.pathname;
  const query = parsed.query;

  // ---- قراءة ----
  if (route === '/api/tree' && req.method === 'GET') {
    return sendJSON(res, 200, { root: path.basename(ROOT), tree: await listTree(ROOT, '') });
  }

  if (route === '/api/file' && req.method === 'GET') {
    const abs = safePath(query.path);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw Object.assign(new Error('ليس ملفاً'), { status: 400 });
    if (!isTextFile(abs)) return sendJSON(res, 200, { binary: true, size: st.size });
    if (st.size > MAX_EDIT_SIZE) {
      throw Object.assign(new Error('الملف أكبر من الحد المسموح للتحرير'), { status: 413 });
    }
    const content = await fsp.readFile(abs, 'utf8');
    return sendJSON(res, 200, { binary: false, content, size: st.size, mtime: st.mtimeMs });
  }

  if (route === '/api/raw' && req.method === 'GET') {
    const abs = safePath(query.path);
    const st = await fsp.stat(abs);
    res.writeHead(200, {
      'Content-Type': mimeOf(abs),
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  if (route === '/api/download' && req.method === 'GET') {
    const abs = safePath(query.path);
    const st = await fsp.stat(abs);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  if (route === '/api/search' && req.method === 'GET') {
    const q = (query.q || '').trim();
    if (!q) return sendJSON(res, 200, { results: [] });
    return sendJSON(res, 200, { results: await searchFiles(q) });
  }

  // ---- كتابة ----
  if (route === '/api/file' && req.method === 'POST') {
    const { path: rel, content } = await readJSONBody(req);
    const abs = safePath(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content ?? '', 'utf8');
    const st = await fsp.stat(abs);
    return sendJSON(res, 200, { ok: true, size: st.size, mtime: st.mtimeMs });
  }

  if (route === '/api/mkdir' && req.method === 'POST') {
    const { path: rel } = await readJSONBody(req);
    await fsp.mkdir(safePath(rel), { recursive: true });
    return sendJSON(res, 200, { ok: true });
  }

  if (route === '/api/rename' && req.method === 'POST') {
    const { from, to } = await readJSONBody(req);
    const absTo = safePath(to);
    await fsp.mkdir(path.dirname(absTo), { recursive: true });
    await fsp.rename(safePath(from), absTo);
    return sendJSON(res, 200, { ok: true });
  }

  if (route === '/api/delete' && req.method === 'POST') {
    const { path: rel } = await readJSONBody(req);
    const abs = safePath(rel);
    if (abs === ROOT) throw Object.assign(new Error('لا يمكن حذف مجلد الجذر'), { status: 400 });
    await fsp.rm(abs, { recursive: true, force: true });
    return sendJSON(res, 200, { ok: true });
  }

  if (route === '/api/upload' && req.method === 'POST') {
    // رفع خام: ?path=<اسم الملف> والجسم هو محتوى الملف
    const abs = safePath(query.path);
    const buf = await readBody(req, 50 * 1024 * 1024);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buf);
    return sendJSON(res, 200, { ok: true, size: buf.length });
  }

  // ---- تشغيل ----
  if (route === '/api/run' && req.method === 'POST') {
    const { path: rel, stdin } = await readJSONBody(req);
    const abs = safePath(rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw Object.assign(new Error('ليس ملفاً'), { status: 400 });
    const result = await runFile(abs, stdin);
    return sendJSON(res, 200, result);
  }

  throw Object.assign(new Error('غير موجود'), { status: 404 });
}

// ---------- الخادم ----------
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  try {
    if (parsed.pathname.startsWith('/api/')) {
      await handleAPI(req, res, parsed);
      return;
    }
    // ملفات الواجهة
    let rel = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    const abs = path.resolve(PUBLIC_DIR, '.' + rel);
    if (!abs.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — غير موجود');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeOf(abs) });
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    const status = e.status || (e.code === 'ENOENT' ? 404 : 500);
    sendJSON(res, status, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   KON — مدير الملفات الذكي               ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  الواجهة:      http://localhost:${PORT}`);
  console.log(`  مجلد العمل:   ${ROOT}`);
});
