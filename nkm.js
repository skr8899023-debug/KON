'use strict';
/**
 * nkm.js — محلّل ملفات Native Instruments Kontakt Multi (.nkm)
 *
 * تنسيق NI FileContainer:
 *   - أول 4 بايت (u32 LE) = الحجم الكلّي المعلن للملف.
 *   - حاويات متداخلة بعلامات: "hsin" (ترويسة/غلاف)، "DSIN" (عنصر بيانات)، "4KIN" (كتلة صوت/عيّنة).
 *   - GUID بطول 16 بايت يبدأ عند الإزاحة 24.
 *   - قد تتضمّن سكربتات Kontakt (KSP) نصية مضمّنة.
 *
 * هذا محلّل بأفضل جهد (best-effort) للفحص والتحرير الآمن؛
 * التنسيق مغلق المصدر من Native Instruments، لذا نركّز على ما يمكن استخراجه
 * وتحريره بأمان (سلاسل نصية بنفس الطول + تعديل بايتات عند إزاحة محدّدة).
 */

const MARKERS = ['hsin', 'DSIN', '4KIN'];

/** هل هذا الملف حاوية NI FileContainer (nkm/nki/nkr…)؟ */
function isNKM(buf) {
  if (!buf || buf.length < 32) return false;
  const hasHsin = buf.indexOf('hsin', 0, 'latin1') >= 0;
  const hasDsin = buf.indexOf('DSIN', 0, 'latin1') >= 0;
  if (!hasHsin || !hasDsin) return false;
  // إمّا الحجم المعلن قريب من الفعلي، أو علامة hsin عند الإزاحة القياسية 12
  const declared = buf.readUInt32LE(0);
  return Math.abs(declared - buf.length) < 4096 || buf.toString('latin1', 12, 16) === 'hsin';
}

const FORMAT_NAMES = {
  '.nkm': 'Native Instruments Kontakt Multi (.nkm)',
  '.nki': 'Native Instruments Kontakt Instrument (.nki)',
  '.nkr': 'Native Instruments Kontakt Resource (.nkr)',
  '.nkc': 'Native Instruments Kontakt Cache (.nkc)',
};

/** يجد كل مواضع علامة معيّنة */
function findAll(buf, marker) {
  const positions = [];
  let i = 0;
  const needle = Buffer.from(marker, 'latin1');
  while (true) {
    i = buf.indexOf(needle, i);
    if (i < 0) break;
    positions.push(i);
    i += 1;
  }
  return positions;
}

/** يبني خريطة العناصر (segments) مع الإزاحة والقيم المجاورة */
function buildSegments(buf) {
  const segs = [];
  for (const m of MARKERS) {
    for (const off of findAll(buf, m)) {
      // القيم المجاورة المفيدة للتشخيص
      const before = off >= 4 ? buf.readUInt32LE(off - 4) : null;
      const after = off + 8 <= buf.length ? buf.readUInt32LE(off + 4) : null;
      segs.push({ marker: m, offset: off, sizeBefore: before, valueAfter: after });
    }
  }
  segs.sort((a, b) => a.offset - b.offset);
  return segs;
}

/** يستخرج السلاسل النصية القابلة للقراءة (ASCII) مع مواضعها وأطوالها */
function extractStrings(buf, minLen = 5, max = 4000) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const c = i < buf.length ? buf[i] : 0;
    const printable = c >= 0x20 && c <= 0x7e;
    if (printable) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= minLen) {
        out.push({ offset: start, length: i - start, text: buf.toString('latin1', start, i) });
        if (out.length >= max) break;
      }
      start = -1;
    }
  }
  return out;
}

/** يحاول استخراج سكربت KSP (يبدأ عادةً عند "on init") مع سياقه.
 *  سكربت Kontakt مُرمّز جزئياً بأجزاء ثنائية متداخلة، لذا نمسح نافذة
 *  حول البداية ونحتفظ بالأجزاء النصية المقروءة (طول ≥ 3) مفصولةً بمسافات. */
function extractScript(buf) {
  const idx = buf.indexOf('on init', 0, 'latin1');
  if (idx < 0) return null;
  const WINDOW = 16000;
  const start = idx;
  const end = Math.min(buf.length, idx + WINDOW);
  const parts = [];
  let runStart = -1;
  for (let i = start; i <= end; i++) {
    const printable = i < end && isTextByte(buf[i]);
    if (printable) { if (runStart < 0) runStart = i; }
    else {
      if (runStart >= 0 && i - runStart >= 3) parts.push(buf.toString('latin1', runStart, i));
      runStart = -1;
    }
  }
  const text = parts.join(' ');
  return { offset: start, length: end - start, text, fragments: parts.length };
}
function isTextByte(c) {
  return (c >= 0x20 && c <= 0x7e) || c === 0x09;
}

/** يستخرج السلاسل النصية UTF-16LE (شائعة في ترويسات nki/nkm) */
function extractStringsUtf16(buf, minLen = 4, max = 300) {
  const out = [];
  const printable = (i) => i + 1 < buf.length && buf[i + 1] === 0 && buf[i] >= 0x20 && buf[i] <= 0x7e;
  let i = 0;
  while (i + 1 < buf.length && out.length < max) {
    if (!printable(i)) { i++; continue; }
    const start = i;
    let count = 0;
    while (printable(i)) { count++; i += 2; }
    if (count >= minLen) {
      out.push({ offset: start, length: count * 2, text: buf.toString('utf16le', start, start + count * 2), utf16: true });
    }
  }
  return out;
}

/** بيانات وصفية معروفة نبحث عنها */
function detectMeta(buf, strings, utf16Strings) {
  const meta = {};
  const joined = strings.map((s) => s.text);
  const wide = (utf16Strings || []).map((s) => s.text);
  const find = (re) => joined.find((t) => re.test(t));
  meta.template = find(/TEMPLATE INSTRUMENT/i) || null;
  meta.author = (find(/RIGID AUDIO|Native Instruments/i) || '').replace(/^.*?:\s*/, '').trim() || null;
  meta.hasScript = buf.indexOf('on init', 0, 'latin1') >= 0;
  meta.scriptTitle = (() => {
    const m = joined.find((t) => /_script_title/i.test(t));
    if (!m) return null;
    const mm = m.match(/_script_title\("([^"]*)"\)/);
    return mm ? mm[1] : m;
  })();
  // من سلاسل UTF-16: اسم الآلة، النوع، الإصدار
  const kIdx = wide.findIndex((t) => t === 'Kontakt');
  meta.instrumentName = kIdx > 0 ? wide[kIdx - 1].trim() : (wide.find((t) => /^[\w][\w .\-]{2,40}$/.test(t) && !/Kontakt|color|device|sound|tempo|ver|visib/i.test(t)) || null);
  meta.contentType = wide.find((t) => /^Kontakt(Instrument|Multi|Bank)$/.test(t)) || null;
  meta.appVersion = wide.find((t) => /^\d+\.\d+\.\d+\.\d+$/.test(t)) || null;
  meta.link = (joined.find((t) => /https?:\/\//.test(t)) || '').match(/https?:\/\/\S+/)?.[0] || null;
  return meta;
}

/** التحليل الكامل لحاوية NI (nkm/nki/…) */
function analyze(buf, ext = '.nkm') {
  const declared = buf.readUInt32LE(0);
  const segments = buildSegments(buf);
  const counts = {};
  for (const m of MARKERS) counts[m] = 0;
  for (const s of segments) counts[s.marker]++;
  const strings = extractStrings(buf, 5);
  const utf16Strings = extractStringsUtf16(buf, 4);
  const meta = detectMeta(buf, strings, utf16Strings);
  const guid = buf.length >= 40 ? buf.toString('hex', 24, 40) : null;
  return {
    format: FORMAT_NAMES[ext.toLowerCase()] || `Native Instruments FileContainer (${ext})`,
    formatFamily: 'NI FileContainer',
    fileSize: buf.length,
    declaredSize: declared,
    sizeMatches: declared === buf.length,
    guid,
    counts,
    segmentTotal: segments.length,
    segments: segments.slice(0, 500),
    meta,
    stringCount: strings.length,
    // سلاسل ASCII قابلة للتحرير + سلاسل UTF-16 للعرض
    strings: strings.filter((s) => s.length >= 6).slice(0, 1500),
    utf16Strings: utf16Strings.slice(0, 300),
    script: extractScript(buf),
  };
}

/** يطبّق تعديلات بايتات آمنة (بنفس الطول) ويعيد Buffer جديداً */
function applyPatches(buf, patches) {
  const copy = Buffer.from(buf);
  for (const p of patches) {
    const off = p.offset | 0;
    let bytes;
    if (p.hex != null) bytes = Buffer.from(p.hex.replace(/\s+/g, ''), 'hex');
    else if (p.text != null) bytes = Buffer.from(p.text, 'latin1');
    else continue;
    if (off < 0 || off + bytes.length > copy.length) {
      throw new Error(`تعديل خارج حدود الملف عند الإزاحة ${off}`);
    }
    bytes.copy(copy, off);
  }
  return copy;
}

/** يستبدل سلسلة نصية بأخرى بنفس الطول تماماً (آمن للتنسيق الثنائي) */
function replaceString(buf, offset, oldText, newText) {
  if (Buffer.byteLength(newText, 'latin1') !== oldText.length) {
    throw new Error(`يجب أن يكون النص الجديد بنفس طول القديم (${oldText.length} بايت) للحفاظ على سلامة الملف`);
  }
  const current = buf.toString('latin1', offset, offset + oldText.length);
  if (current !== oldText) {
    throw new Error('النص عند هذه الإزاحة لا يطابق المتوقّع — قد يكون الملف تغيّر');
  }
  return applyPatches(buf, [{ offset, text: newText }]);
}

/** مقطع hex منسّق */
function hexSlice(buf, offset, length) {
  const start = Math.max(0, offset | 0);
  const end = Math.min(buf.length, start + (length | 0));
  const rows = [];
  for (let i = start; i < end; i += 16) {
    const slice = buf.subarray(i, Math.min(end, i + 16));
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
    rows.push({ offset: i, hex, ascii });
  }
  return { start, end, rows };
}

module.exports = { isNKM, analyze, applyPatches, replaceString, hexSlice, extractStrings, buildSegments };
