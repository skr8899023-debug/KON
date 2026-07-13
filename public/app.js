'use strict';

/* ================= الحالة ================= */
const state = {
  tree: null,
  tabs: [],        // { path, name, content, original, binary, mime, runnable, text }
  active: null,    // مسار التبويب النشط
  collapsed: new Set(),
};

/* ================= أدوات مساعدة ================= */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `خطأ ${res.status}`);
    return data;
  }
  if (!res.ok) throw new Error(`خطأ ${res.status}`);
  return res;
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2800);
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' ب';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' ك.ب';
  return (n / 1024 / 1024).toFixed(1) + ' م.ب';
}

function iconFor(name, isDir) {
  if (isDir) return '📁';
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    js: '🟨', mjs: '🟨', cjs: '🟨', ts: '🔷', jsx: '⚛️', tsx: '⚛️',
    json: '🟫', html: '🌐', htm: '🌐', css: '🎨', scss: '🎨',
    py: '🐍', rb: '💎', php: '🐘', sh: '🐚', bash: '🐚',
    md: '📝', txt: '📄', csv: '📊', xml: '📋', yml: '⚙️', yaml: '⚙️',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    mp3: '🎵', wav: '🎵', mp4: '🎬', pdf: '📕', zip: '📦',
    nkm: '🥁', nki: '🎹', nkr: '🎹', nksn: '🎛️', mid: '🎼', midi: '🎼',
  };
  return map[ext] || '📄';
}

/* ================= شجرة الملفات ================= */
async function loadTree() {
  const data = await api('/api/tree');
  state.tree = data.tree;
  $('#root-name').textContent = data.root;
  renderTree();
}

function renderTree() {
  const container = $('#tree');
  container.innerHTML = '';
  if (!state.tree || !state.tree.length) {
    container.appendChild(el('div', 'empty-state', 'المجلد فارغ — أنشئ ملفاً للبدء.'));
    return;
  }
  for (const node of state.tree) container.appendChild(renderNode(node));
}

function renderNode(node) {
  const wrap = el('div', 'node');
  const row = el('div', 'node-row');
  row.dataset.path = node.path;

  if (node.type === 'dir') {
    const collapsed = state.collapsed.has(node.path);
    const twist = el('span', 'twist', collapsed ? '▶' : '▼');
    row.appendChild(twist);
    row.appendChild(el('span', 'ico', '📁'));
    row.appendChild(el('span', 'nm', node.name));
    const childBox = el('div', 'children' + (collapsed ? ' collapsed' : ''));
    for (const c of node.children || []) childBox.appendChild(renderNode(c));
    row.onclick = () => {
      if (state.collapsed.has(node.path)) state.collapsed.delete(node.path);
      else state.collapsed.add(node.path);
      childBox.classList.toggle('collapsed');
      twist.textContent = childBox.classList.contains('collapsed') ? '▶' : '▼';
    };
    row.oncontextmenu = (e) => ctxMenu(e, node);
    wrap.appendChild(row);
    wrap.appendChild(childBox);
  } else {
    row.appendChild(el('span', 'twist', ''));
    row.appendChild(el('span', 'ico', iconFor(node.name, false)));
    row.appendChild(el('span', 'nm', node.name));
    row.appendChild(el('span', 'sz', fmtSize(node.size)));
    if (state.active === node.path) row.classList.add('active');
    row.onclick = () => openFile(node.path, node.name);
    row.oncontextmenu = (e) => ctxMenu(e, node);
    wrap.appendChild(row);
  }
  return wrap;
}

function highlightActive() {
  document.querySelectorAll('.node-row').forEach((r) => {
    r.classList.toggle('active', r.dataset.path === state.active);
  });
}

/* ================= التبويبات ================= */
function renderTabs() {
  const bar = $('#tabs');
  bar.innerHTML = '';
  for (const t of state.tabs) {
    const tab = el('div', 'tab' + (t.path === state.active ? ' active' : ''));
    const dirty = t.content !== t.original;
    tab.appendChild(el('span', 'ico', iconFor(t.name, false)));
    const nm = el('span', '', t.name);
    tab.appendChild(nm);
    if (dirty) { const d = el('span', 'd', '●'); tab.appendChild(d); }
    const x = el('span', 'x', '✕');
    x.onclick = (e) => { e.stopPropagation(); closeTab(t.path); };
    tab.appendChild(x);
    tab.onclick = () => switchTab(t.path);
    bar.appendChild(tab);
  }
}

function switchTab(path) {
  state.active = path;
  const t = state.tabs.find((x) => x.path === path);
  if (!t) { showEmpty(); return; }
  renderTabs();
  highlightActive();
  showTab(t);
}

function closeTab(path) {
  const t = state.tabs.find((x) => x.path === path);
  if (t && t.content !== t.original && !confirm(`"${t.name}" يحتوي تغييرات غير محفوظة. إغلاق دون حفظ؟`)) return;
  if (t && t.midi && typeof stopStudioPlayback === 'function') stopStudioPlayback(t);
  state.tabs = state.tabs.filter((x) => x.path !== path);
  if (state.active === path) {
    state.active = state.tabs.length ? state.tabs[state.tabs.length - 1].path : null;
  }
  renderTabs();
  if (state.active) switchTab(state.active);
  else showEmpty();
}

/* ================= فتح / عرض الملفات ================= */
async function openFile(path, name) {
  const existing = state.tabs.find((t) => t.path === path);
  if (existing) { switchTab(path); return; }
  const ext = name.split('.').pop().toLowerCase();
  // ملفات Kontakt (.nkm/.nki/.nkr) تُفتح في المفتّش المتخصّص
  if (['nkm', 'nki', 'nkr', 'nkc'].includes(ext)) {
    const tab = { path, name, nkm: true, binary: true, text: false, content: '', original: '', runnable: false };
    state.tabs.push(tab);
    switchTab(path);
    return;
  }
  // ملفات MIDI تُفتح في استوديو الموسيقى
  if (['mid', 'midi'].includes(ext)) {
    const tab = { path, name, midi: true, binary: true, text: false, content: '', original: '', runnable: false };
    state.tabs.push(tab);
    switchTab(path);
    return;
  }
  try {
    const info = await api('/api/file?path=' + encodeURIComponent(path));
    const ext = name.split('.').pop().toLowerCase();
    const tab = {
      path, name,
      binary: !!info.binary,
      content: info.binary ? '' : info.content,
      original: info.binary ? '' : info.content,
      size: info.size,
      mime: '',
      runnable: ['js', 'mjs', 'cjs', 'py', 'sh', 'bash', 'rb', 'php'].includes(ext),
      text: !info.binary,
    };
    state.tabs.push(tab);
    switchTab(path);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function stopAllStudios() {
  for (const tb of state.tabs) {
    if (tb.midi && typeof stopStudioPlayback === 'function') stopStudioPlayback(tb);
  }
}

function showEmpty() {
  stopAllStudios();
  $('#empty-state').classList.remove('hidden');
  $('#editor-area').classList.add('hidden');
  $('#preview').classList.add('hidden');
  $('#nkm').classList.add('hidden');
  $('#studio').classList.add('hidden');
  $('#toolbar').hidden = true;
  $('#console').classList.add('hidden');
  state.active = null;
  renderTabs();
  highlightActive();
}

function showTab(t) {
  $('#empty-state').classList.add('hidden');
  $('#toolbar').hidden = false;
  $('#current-path').textContent = t.path;
  $('#btn-run').classList.toggle('hidden', !t.runnable);
  $('#dirty-dot').classList.toggle('hidden', t.content === t.original);

  if (t.nkm) {
    stopAllStudios();
    $('#editor-area').classList.add('hidden');
    $('#preview').classList.add('hidden');
    $('#studio').classList.add('hidden');
    $('#btn-save').classList.add('hidden');
    showNKM(t);
    return;
  }
  $('#nkm').classList.add('hidden');

  if (t.midi) {
    // أوقف تشغيل تبويبات أخرى قبل عرض هذا الاستوديو
    for (const tb of state.tabs) if (tb !== t && tb.midi) stopStudioPlayback(tb);
    $('#editor-area').classList.add('hidden');
    $('#preview').classList.add('hidden');
    $('#btn-save').classList.add('hidden');
    showStudio(t);
    return;
  }
  $('#studio').classList.add('hidden');
  stopAllStudios();

  if (t.binary || !t.text) {
    showPreview(t);
    $('#editor-area').classList.add('hidden');
    $('#btn-save').classList.add('hidden');
  } else {
    $('#preview').classList.add('hidden');
    $('#editor-area').classList.remove('hidden');
    $('#btn-save').classList.remove('hidden');
    const ed = $('#editor');
    ed.value = t.content;
    updateGutter();
    ed.focus();
  }
}

function showPreview(t) {
  const p = $('#preview');
  p.classList.remove('hidden');
  p.innerHTML = '';
  const ext = t.name.split('.').pop().toLowerCase();
  const raw = '/api/raw?path=' + encodeURIComponent(t.path);
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
    const img = el('img'); img.src = raw; p.appendChild(img);
  } else if (['mp4', 'webm'].includes(ext)) {
    const v = el('video'); v.src = raw; v.controls = true; p.appendChild(v);
  } else if (['mp3', 'wav', 'ogg'].includes(ext)) {
    const a = el('audio'); a.src = raw; a.controls = true; p.appendChild(a);
  } else if (ext === 'pdf') {
    const f = el('iframe'); f.src = raw; p.appendChild(f);
  } else {
    const note = el('div', 'binary-note');
    note.innerHTML = `📦 ملف ثنائي (${fmtSize(t.size)})<br/><br/>لا يمكن عرضه كنص. استخدم زر التنزيل ⬇`;
    p.appendChild(note);
  }
}

/* ================= مفتّش ملفات Kontakt Multi (.nkm) ================= */
async function showNKM(t) {
  const box = $('#nkm');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="nkm-loading">⏳ جارٍ تحليل ملف Kontakt Multi…</div>';
  try {
    const a = await api('/api/nkm?path=' + encodeURIComponent(t.path));
    t.analysis = a;
    renderNKM(t, 'info');
  } catch (e) {
    box.innerHTML = `<div class="nkm-loading err">تعذّر التحليل: ${escapeHtml(e.message)}</div>`;
  }
}

function renderNKM(t, view) {
  const a = t.analysis;
  const box = $('#nkm');
  box.innerHTML = '';

  // شريط تبويبات المفتّش
  const nav = el('div', 'nkm-nav');
  const views = [
    ['info', '📋 معلومات'],
    ['segments', '🧩 الحاويات'],
    ['strings', '🔤 النصوص والسكربت'],
    ['hex', '🔢 Hex'],
  ];
  for (const [id, label] of views) {
    const b = el('button', 'nkm-tab' + (view === id ? ' active' : ''), label);
    b.onclick = () => renderNKM(t, id);
    nav.appendChild(b);
  }
  box.appendChild(nav);

  const body = el('div', 'nkm-body');
  box.appendChild(body);

  if (view === 'info') renderNKMInfo(body, a);
  else if (view === 'segments') renderNKMSegments(body, a);
  else if (view === 'strings') renderNKMStrings(body, t, a);
  else if (view === 'hex') renderNKMHex(body, t, a);
}

function kv(k, v) {
  const row = el('div', 'kv');
  row.appendChild(el('span', 'k', k));
  const val = el('span', 'v');
  if (v instanceof Node) val.appendChild(v); else val.textContent = v;
  row.appendChild(val);
  return row;
}

function renderNKMInfo(body, a) {
  const card = el('div', 'nkm-card');
  card.appendChild(el('h3', '', '🥁 ' + a.format));
  const g = el('div', 'nkm-grid');
  g.appendChild(kv('عائلة التنسيق', a.formatFamily));
  g.appendChild(kv('حجم الملف', a.fileSize.toLocaleString('ar') + ' بايت'));
  g.appendChild(kv('الحجم المعلن', a.declaredSize.toLocaleString('ar') + (a.sizeMatches ? ' ✓ مطابق' : ' ⚠ غير مطابق')));
  g.appendChild(kv('المعرّف GUID', mono(a.guid || '—')));
  g.appendChild(kv('إجمالي الحاويات', String(a.segmentTotal)));
  g.appendChild(kv('hsin / DSIN / 4KIN', `${a.counts.hsin} / ${a.counts.DSIN} / ${a.counts['4KIN']}`));
  card.appendChild(g);
  body.appendChild(card);

  const meta = el('div', 'nkm-card');
  meta.appendChild(el('h3', '', '🎛️ البيانات الوصفية'));
  const mg = el('div', 'nkm-grid');
  if (a.meta.instrumentName) mg.appendChild(kv('اسم الآلة/الطقم', a.meta.instrumentName));
  if (a.meta.contentType) mg.appendChild(kv('نوع المحتوى', a.meta.contentType));
  if (a.meta.appVersion) mg.appendChild(kv('إصدار Kontakt', a.meta.appVersion));
  mg.appendChild(kv('القالب', a.meta.template || '—'));
  mg.appendChild(kv('المؤلف/المصدر', a.meta.author || '—'));
  mg.appendChild(kv('يحتوي سكربت KSP', a.meta.hasScript ? 'نعم ✓' : 'لا'));
  mg.appendChild(kv('عنوان السكربت', a.meta.scriptTitle || '—'));
  if (a.meta.link) mg.appendChild(kv('رابط', a.meta.link));
  mg.appendChild(kv('عدد السلاسل النصية', String(a.stringCount)));
  meta.appendChild(mg);
  body.appendChild(meta);

  const note = el('div', 'nkm-note');
  note.innerHTML = '💡 هذا تنسيق ثنائي مغلق المصدر من Native Instruments. يوفّر المفتّش قراءةً كاملة للبنية والبيانات الوصفية، وتحريراً <b>آمناً</b> للنصوص (بنفس الطول) وتعديلاً على مستوى البايت مع أخذ نسخة احتياطية تلقائية (<code>.bak</code>).';
  body.appendChild(note);
}

function mono(s) { const e = el('code'); e.textContent = s; return e; }

function renderNKMSegments(body, a) {
  const card = el('div', 'nkm-card');
  card.appendChild(el('h3', '', `🧩 خريطة الحاويات (${a.segments.length})`));
  const table = el('table', 'nkm-table');
  table.innerHTML = '<thead><tr><th>#</th><th>العلامة</th><th>الإزاحة</th><th>الحجم قبل</th><th>القيمة بعد</th></tr></thead>';
  const tb = el('tbody');
  a.segments.forEach((s, i) => {
    const tr = el('tr');
    tr.innerHTML = `<td>${i + 1}</td><td><span class="seg seg-${s.marker}">${s.marker}</span></td>` +
      `<td class="mono">${s.offset}</td><td class="mono">${s.sizeBefore ?? '—'}</td><td class="mono">${s.valueAfter ?? '—'}</td>`;
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  const wrap = el('div', 'nkm-tablewrap');
  wrap.appendChild(table);
  card.appendChild(wrap);
  body.appendChild(card);
}

function renderNKMStrings(body, t, a) {
  // السكربت المستخرج
  if (a.script && a.script.text) {
    const sc = el('div', 'nkm-card');
    sc.appendChild(el('h3', '', `🧾 سكربت Kontakt (KSP) — إزاحة ${a.script.offset}`));
    const pre = el('pre', 'nkm-script');
    pre.textContent = a.script.text;
    sc.appendChild(pre);
    body.appendChild(sc);
  }

  const card = el('div', 'nkm-card');
  const head = el('div', 'nkm-strhead');
  head.appendChild(el('h3', '', `🔤 السلاسل النصية (${a.strings.length})`));
  const filter = el('input', 'nkm-filter');
  filter.placeholder = 'تصفية…';
  head.appendChild(filter);
  card.appendChild(head);

  const list = el('div', 'nkm-strlist');
  const render = (q) => {
    list.innerHTML = '';
    const ql = (q || '').toLowerCase();
    const all = [...(a.utf16Strings || []), ...a.strings];
    const items = all.filter((s) => !ql || s.text.toLowerCase().includes(ql)).slice(0, 400);
    for (const s of items) {
      const row = el('div', 'nkm-str');
      const off = el('span', 'nkm-str-off', '@' + s.offset + (s.utf16 ? ' 🅆' : ''));
      const txt = el('span', 'nkm-str-txt', s.text);
      row.appendChild(off); row.appendChild(txt);
      if (!s.utf16) {
        const edit = el('button', 'nkm-str-edit', '✏');
        edit.title = 'تعديل بنفس الطول';
        edit.onclick = () => editNKMString(t, s);
        row.appendChild(edit);
      } else {
        row.title = 'سلسلة UTF-16 (للعرض فقط)';
      }
      list.appendChild(row);
    }
    if (!items.length) list.appendChild(el('div', 'nkm-loading', 'لا نتائج.'));
  };
  filter.oninput = () => render(filter.value);
  render('');
  card.appendChild(list);
  body.appendChild(card);
}

async function editNKMString(t, s) {
  const nv = prompt(`تعديل النص (يجب أن يبقى بطول ${s.length} حرفاً بالضبط):`, s.text);
  if (nv == null || nv === s.text) return;
  if (nv.length !== s.length) {
    toast(`الطول يجب أن يكون ${s.length} حرفاً (أدخلت ${nv.length}). لِمَ لا تُكمل بمسافات؟`, 'err');
    return;
  }
  try {
    const r = await api('/api/nkm/patch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: t.path, replace: { offset: s.offset, oldText: s.text, newText: nv } }),
    });
    toast(`تم التعديل ✓ (نسخة احتياطية: ${r.backup})`, 'ok');
    // أعد التحليل
    await showNKM(t);
  } catch (e) { toast(e.message, 'err'); }
}

async function renderNKMHex(body, t, a) {
  const card = el('div', 'nkm-card');
  const head = el('div', 'nkm-strhead');
  head.appendChild(el('h3', '', '🔢 عارض/محرّر Hex'));
  const offInput = el('input', 'nkm-hexoff');
  offInput.type = 'number'; offInput.value = t.hexOffset || 0; offInput.min = 0;
  offInput.style.width = '120px';
  const go = el('button', 'btn small', 'اذهب');
  head.appendChild(el('span', '', 'الإزاحة:'));
  head.appendChild(offInput);
  head.appendChild(go);
  card.appendChild(head);

  const out = el('div', 'nkm-hexout');
  card.appendChild(out);
  body.appendChild(card);

  const load = async (offset) => {
    t.hexOffset = offset;
    out.textContent = '⏳…';
    try {
      const h = await api(`/api/nkm/hex?path=${encodeURIComponent(t.path)}&offset=${offset}&length=512`);
      out.innerHTML = '';
      for (const r of h.rows) {
        const line = el('div', 'hexrow');
        line.innerHTML = `<span class="hex-off">${r.offset.toString(16).padStart(8, '0')}</span>` +
          `<span class="hex-bytes">${r.hex}</span><span class="hex-ascii">${escapeHtml(r.ascii)}</span>`;
        out.appendChild(line);
      }
    } catch (e) { out.textContent = e.message; }
  };
  go.onclick = () => load(parseInt(offInput.value, 10) || 0);
  await load(parseInt(offInput.value, 10) || 0);
}

/* ================= المحرر ================= */
function updateGutter() {
  const ed = $('#editor');
  const lines = ed.value.split('\n').length;
  const g = $('#gutter');
  let html = '';
  for (let i = 1; i <= lines; i++) html += i + '\n';
  g.textContent = html;
}

$('#editor').addEventListener('input', () => {
  const t = state.tabs.find((x) => x.path === state.active);
  if (!t) return;
  t.content = $('#editor').value;
  $('#dirty-dot').classList.toggle('hidden', t.content === t.original);
  updateGutter();
  renderTabs();
});
$('#editor').addEventListener('scroll', () => {
  $('#gutter').scrollTop = $('#editor').scrollTop;
});
// دعم مفتاح Tab داخل المحرر
$('#editor').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const ed = e.target;
    const s = ed.selectionStart, en = ed.selectionEnd;
    ed.value = ed.value.slice(0, s) + '  ' + ed.value.slice(en);
    ed.selectionStart = ed.selectionEnd = s + 2;
    ed.dispatchEvent(new Event('input'));
  }
});

/* ================= الإجراءات ================= */
async function saveActive() {
  const t = state.tabs.find((x) => x.path === state.active);
  if (!t || !t.text) return;
  try {
    await api('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: t.path, content: t.content }),
    });
    t.original = t.content;
    $('#dirty-dot').classList.add('hidden');
    renderTabs();
    toast('تم الحفظ ✓', 'ok');
    await loadTree();
    highlightActive();
  } catch (e) { toast(e.message, 'err'); }
}

async function runActive() {
  const t = state.tabs.find((x) => x.path === state.active);
  if (!t || !t.runnable) return;
  if (t.content !== t.original) await saveActive();
  const con = $('#console');
  con.classList.remove('hidden');
  const body = $('#console-body');
  body.textContent = '⏳ جارٍ التشغيل…';
  $('#run-meta').textContent = '';
  try {
    const r = await api('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: t.path }),
    });
    body.innerHTML = '';
    if (!r.ok) { body.innerHTML = `<span class="err">${escapeHtml(r.error)}</span>`; return; }
    if (r.stdout) body.appendChild(spanText(r.stdout));
    if (r.stderr) { const s = spanText(r.stderr); s.className = 'err'; body.appendChild(s); }
    if (!r.stdout && !r.stderr) body.appendChild(spanText('(لا توجد مخرجات)'));
    if (r.truncated) body.appendChild(spanText('\n… (تم اقتطاع المخرجات)'));
    const status = r.timedOut ? `⏱ انتهت المهلة` : r.code === 0 ? '✓ نجح' : `✗ خرج بالرمز ${r.code}`;
    $('#run-meta').innerHTML = `<span class="${r.code === 0 ? 'ok' : 'err'}">${status}</span> · ${r.durationMs} م.ث`;
  } catch (e) {
    body.innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`;
  }
}
function spanText(txt) { const s = el('span'); s.textContent = txt; return s; }
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

async function deleteActive() {
  const t = state.tabs.find((x) => x.path === state.active);
  if (!t) return;
  if (!confirm(`حذف "${t.name}" نهائياً؟`)) return;
  await deletePath(t.path);
}
async function deletePath(path) {
  try {
    await api('/api/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    state.tabs = state.tabs.filter((x) => x.path !== path);
    if (state.active === path) state.active = state.tabs.length ? state.tabs[0].path : null;
    toast('تم الحذف', 'ok');
    await loadTree();
    if (state.active) switchTab(state.active); else showEmpty();
  } catch (e) { toast(e.message, 'err'); }
}

async function renamePath(path, oldName) {
  const to = prompt('المسار/الاسم الجديد:', path);
  if (!to || to === path) return;
  try {
    await api('/api/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: path, to }),
    });
    const t = state.tabs.find((x) => x.path === path);
    if (t) { t.path = to; t.name = to.split('/').pop(); if (state.active === path) state.active = to; }
    toast('تمت إعادة التسمية', 'ok');
    await loadTree();
    renderTabs();
    highlightActive();
  } catch (e) { toast(e.message, 'err'); }
}

async function newFile(dir = '') {
  const name = prompt('اسم الملف الجديد' + (dir ? ` (داخل ${dir})` : '') + ':', 'ملف.txt');
  if (!name) return;
  const full = dir ? `${dir}/${name}` : name;
  try {
    await api('/api/file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: full, content: '' }),
    });
    await loadTree();
    await openFile(full, name);
    toast('تم إنشاء الملف ✓', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function newFolder(dir = '') {
  const name = prompt('اسم المجلد الجديد:', 'مجلد');
  if (!name) return;
  const full = dir ? `${dir}/${name}` : name;
  try {
    await api('/api/mkdir', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: full }),
    });
    await loadTree();
    toast('تم إنشاء المجلد ✓', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

function downloadActive() {
  const t = state.tabs.find((x) => x.path === state.active);
  if (!t) return;
  window.open('/api/download?path=' + encodeURIComponent(t.path), '_blank');
}

/* ================= الرفع ================= */
$('#btn-upload').onclick = () => $('#file-input').click();
$('#file-input').onchange = async (e) => {
  const files = [...e.target.files];
  for (const f of files) {
    try {
      await api('/api/upload?path=' + encodeURIComponent(f.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await f.arrayBuffer(),
      });
    } catch (err) { toast(`فشل رفع ${f.name}: ${err.message}`, 'err'); }
  }
  e.target.value = '';
  await loadTree();
  toast(`تم رفع ${files.length} ملف ✓`, 'ok');
};

/* ================= البحث ================= */
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $('#search-results').classList.add('hidden'); $('#tree').classList.remove('hidden'); return; }
  searchTimer = setTimeout(() => doSearch(q), 280);
});
async function doSearch(q) {
  try {
    const { results } = await api('/api/search?q=' + encodeURIComponent(q));
    const box = $('#search-results');
    box.innerHTML = '';
    box.classList.remove('hidden');
    $('#tree').classList.add('hidden');
    if (!results.length) { box.appendChild(el('div', 'empty-state', 'لا نتائج.')); return; }
    for (const r of results) {
      const d = el('div', 'sr');
      d.innerHTML = `<span class="p">${escapeHtml(r.path)}</span> <span class="ln">${r.line ? ':' + r.line : ''}</span><span class="pv">${escapeHtml(r.preview)}</span>`;
      d.onclick = () => openFile(r.path, r.path.split('/').pop());
      box.appendChild(d);
    }
  } catch (e) { toast(e.message, 'err'); }
}

/* ================= قائمة السياق ================= */
function ctxMenu(e, node) {
  e.preventDefault();
  const m = $('#ctxmenu');
  m.innerHTML = '';
  const items = [];
  if (node.type === 'dir') {
    items.push(['📄 ملف جديد', () => newFile(node.path)]);
    items.push(['📁 مجلد جديد', () => newFolder(node.path)]);
    items.push(['sep']);
  } else {
    items.push(['📂 فتح', () => openFile(node.path, node.name)]);
    items.push(['⬇ تنزيل', () => window.open('/api/download?path=' + encodeURIComponent(node.path), '_blank')]);
  }
  items.push(['✏ إعادة تسمية', () => renamePath(node.path, node.name)]);
  items.push(['sep']);
  items.push(['🗑 حذف', () => { if (confirm(`حذف "${node.name}"؟`)) deletePath(node.path); }, 'danger']);

  for (const it of items) {
    if (it[0] === 'sep') { m.appendChild(el('div', 'sep')); continue; }
    const mi = el('div', 'mi' + (it[2] ? ' ' + it[2] : ''), it[0]);
    mi.onclick = () => { m.classList.add('hidden'); it[1](); };
    m.appendChild(mi);
  }
  m.style.left = Math.min(e.clientX, innerWidth - 180) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - 220) + 'px';
  m.classList.remove('hidden');
}
document.addEventListener('click', () => $('#ctxmenu').classList.add('hidden'));

/* ================= التقسيم القابل للسحب ================= */
(() => {
  const splitter = $('#splitter'), sidebar = $('#sidebar');
  let dragging = false;
  splitter.addEventListener('mousedown', () => { dragging = true; document.body.style.userSelect = 'none'; });
  document.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = window.innerWidth - e.clientX; // RTL: الشريط على اليمين
    sidebar.style.width = Math.max(160, Math.min(560, w)) + 'px';
  });
})();

/* ================= السمة ================= */
$('#btn-theme').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('kon-theme', next);
};
(() => {
  const saved = localStorage.getItem('kon-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
})();

/* ================= الأزرار العامة ================= */
$('#btn-refresh').onclick = () => loadTree();
$('#btn-newfile').onclick = () => newFile('');
$('#btn-newfolder').onclick = () => newFolder('');
$('#btn-save').onclick = saveActive;
$('#btn-run').onclick = runActive;
$('#btn-delete').onclick = deleteActive;
$('#btn-download').onclick = downloadActive;
$('#btn-rename').onclick = () => { const t = state.tabs.find((x) => x.path === state.active); if (t) renamePath(t.path, t.name); };
$('#btn-console-close').onclick = () => $('#console').classList.add('hidden');

/* ================= اختصارات لوحة المفاتيح ================= */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveActive(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runActive(); }
});

/* ================= الإقلاع ================= */
loadTree()
  .then(() => {
    // فتح ملف مباشرة عبر الرابط: #open=مسار/الملف
    const m = location.hash.match(/^#open=(.+)$/);
    if (m) {
      const p = decodeURIComponent(m[1]);
      openFile(p, p.split('/').pop());
    }
  })
  .catch((e) => toast('تعذّر تحميل الملفات: ' + e.message, 'err'));
