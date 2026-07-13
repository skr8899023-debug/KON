/* studio.js — استوديو الموسيقى في KON
 * فتح وتشغيل ملفات MIDI (Web Audio)، تحرير النوتات على Piano Roll،
 * مصفوفة إيقاعات لإضافة ضربات جديدة، وتصدير النتيجة ملف MIDI. */
'use strict';

/* ================= محرك الصوت (طبول مُخلّقة) ================= */
const Engine = (() => {
  let ctx = null, master = null, noiseBuffer = null;

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.75;
      master.connect(ctx.destination);
      const len = ctx.sampleRate * 1;
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function env(node, t, a, peak, dec) {
    node.gain.setValueAtTime(0.0001, t);
    node.gain.linearRampToValueAtTime(peak, t + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t + dec);
  }
  function noise(t, dur, filterType, freq, q, vol) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer;
    const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q || 1;
    const g = ctx.createGain(); env(g, t, 0.002, vol, dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur + 0.05);
  }
  function tone(t, dur, f0, f1, type, vol) {
    const o = ctx.createOscillator(); o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur * 0.8);
    const g = ctx.createGain(); env(g, t, 0.002, vol, dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  const kit = {
    kick:  (t, v, d = 0) => { tone(t, 0.35, 160 + d * 6, 45, 'sine', 0.9 * v); noise(t, 0.03, 'lowpass', 900, 1, 0.3 * v); },
    snare: (t, v, d = 0) => { tone(t, 0.12, 220 + d * 10, 160, 'triangle', 0.4 * v); noise(t, 0.18, 'highpass', 1600, 0.8, 0.5 * v); },
    hatC:  (t, v) => noise(t, 0.05, 'highpass', 7500, 1.2, 0.35 * v),
    hatO:  (t, v) => noise(t, 0.32, 'highpass', 7000, 1.2, 0.3 * v),
    clap:  (t, v) => { for (let i = 0; i < 3; i++) noise(t + i * 0.012, 0.09, 'bandpass', 1400, 2.5, 0.4 * v); },
    tom:   (t, v, d = 0) => tone(t, 0.28, 230 + d * 12, 90 + d * 4, 'sine', 0.7 * v),
    daf:   (t, v) => { tone(t, 0.22, 300, 120, 'triangle', 0.5 * v); noise(t, 0.12, 'bandpass', 800, 2, 0.35 * v); },
    /* طار (Frame drum): رنين جلدي دافئ + صفعة إصبع */
    tarH:  (t, v) => { tone(t, 0.18, 420, 240, 'triangle', 0.45 * v); noise(t, 0.06, 'bandpass', 2600, 3, 0.4 * v); },
    tarL:  (t, v) => { tone(t, 0.3, 200, 85, 'sine', 0.65 * v); noise(t, 0.08, 'bandpass', 1100, 2.5, 0.3 * v); },
  };

  /* نوتة MIDI إيقاعية → صوت مناسب (استدلالياً حسب طبقة النغمة)
     التنويع البسيط بالنغمة (d) يمنح كل ضربة طابعاً خاصاً */
  function perc(t, pitch, vel) {
    const v = Math.min(1, vel / 110);
    const d = pitch % 12;
    if (pitch <= 38) kit.kick(t, v, d);
    else if (pitch <= 43) kit.tom(t, v, d);
    else if (pitch <= 47) kit.snare(t, v, d);
    else if (pitch <= 51) kit.tarL(t, v);
    else if (pitch <= 55) kit.daf(t, v);
    else if (pitch <= 58) kit.tarH(t, v);
    else if (pitch <= 62) kit.clap(t, v);
    else if (pitch % 2 === 0) kit.hatC(t, v);
    else kit.hatO(t, v);
  }

  function setVolume(v) { ensure(); master.gain.value = Math.min(1, Math.max(0, v)); }

  return { ensure, kit, perc, setVolume, now: () => ctx.currentTime, get ctx() { return ctx; } };
})();

/* ================= إعداد المصفوفة الإيقاعية ================= */
const LANES = [
  { id: 'kick', label: '🦶 كيك',        gm: 36 },
  { id: 'snare', label: '🥁 سنير',      gm: 38 },
  { id: 'hatC', label: '🎩 هاي هات',    gm: 42 },
  { id: 'hatO', label: '🎩 هات مفتوح',  gm: 46 },
  { id: 'clap', label: '👏 تصفيق',      gm: 39 },
  { id: 'tom', label: '🪘 توم',         gm: 45 },
  { id: 'daf', label: '🪘 دفّ',         gm: 54 },
  { id: 'tarH', label: '🪘 طار حاد',    gm: 50 },
  { id: 'tarL', label: '🪘 طار غليظ',   gm: 41 },
];
const TRACK_COLORS = ['#4f8cff', '#7c5cff', '#43d492', '#ffcc4d', '#ff5c72', '#3ecfe0', '#e08add'];

/* ================= فتح ملف MIDI في الاستوديو ================= */
async function showStudio(t) {
  const box = $('#studio');
  box.classList.remove('hidden');
  if (!t.st) {
    box.innerHTML = '<div class="nkm-loading">⏳ جارٍ تحميل ملف MIDI…</div>';
    try {
      const res = await fetch('/api/raw?path=' + encodeURIComponent(t.path));
      if (!res.ok) throw new Error('تعذّر جلب الملف');
      const buf = new Uint8Array(await res.arrayBuffer());
      const data = MIDI.parseMIDI(buf);
      const stepTicks = data.division / 4; // خطوة = 1/16
      // خطوات البار حسب الميزان: 4/4 → 16 خطوة، 3/4 → 12 خطوة
      const ts = data.timeSig || { num: 4, den: 4 };
      const stepsPerBar = Math.max(4, Math.round(ts.num * (16 / ts.den)));
      const steps = Math.min(288, Math.max(stepsPerBar, Math.ceil(data.totalTicks / stepTicks / stepsPerBar) * stepsPerBar));
      t.st = {
        data,
        tempo: data.tempo,
        stepTicks,
        stepsPerBar,
        steps,
        volume: 0.75,
        lanes: Object.fromEntries(LANES.map((l) => [l.id, new Array(steps).fill(false)])),
        muted: new Set(),
        selTrack: Math.max(0, data.tracks.findIndex((x) => x.notes.length > 0)),
        playing: false,
        loop: true,
        dirty: false,
      };
    } catch (e) {
      box.innerHTML = `<div class="nkm-loading err">فشل التحليل: ${escapeHtml(e.message)}</div>`;
      return;
    }
  }
  renderStudio(t);
}

function stopStudioPlayback(t) {
  if (t && t.st && t.st.playing) {
    t.st.playing = false;
    clearInterval(t.st.timer);
    cancelAnimationFrame(t.st.raf);
  }
}

/* ================= بناء الواجهة ================= */
function renderStudio(t) {
  const st = t.st;
  const box = $('#studio');
  box.innerHTML = '';

  /* --- شريط النقل (Transport) --- */
  const bar = el('div', 'st-transport');
  const btnPlay = el('button', 'btn accent st-play', st.playing ? '⏹ إيقاف' : '▶ تشغيل');
  btnPlay.onclick = () => (st.playing ? stopPlay(t) : startPlay(t));
  bar.appendChild(btnPlay);

  const bpmWrap = el('span', 'st-bpm');
  bpmWrap.appendChild(el('span', '', 'الإيقاع BPM:'));
  const bpmIn = el('input');
  bpmIn.type = 'number'; bpmIn.min = 30; bpmIn.max = 300;
  bpmIn.value = Math.round(60000000 / st.tempo);
  bpmIn.onchange = () => {
    const b = Math.min(300, Math.max(30, parseInt(bpmIn.value, 10) || 120));
    st.tempo = Math.round(60000000 / b);
    st.dirty = true;
    if (st.playing) { stopPlay(t); startPlay(t); }
  };
  bpmWrap.appendChild(bpmIn);
  bar.appendChild(bpmWrap);

  const loopBtn = el('button', 'btn st-loop' + (st.loop ? ' on' : ''), '🔁 تكرار');
  loopBtn.onclick = () => { st.loop = !st.loop; loopBtn.classList.toggle('on', st.loop); };
  bar.appendChild(loopBtn);

  // عدّاد الموضع الحيّ (بار : ضربة)
  const pos = el('span', 'st-pos', '1 : 1');
  st.posEl = pos;
  bar.appendChild(pos);

  const ts = st.data.timeSig;
  bar.appendChild(el('span', 'st-info',
    `الميزان: ${ts.num}/${ts.den} · القسمة: ${st.data.division} تكّة/ربع · ${st.data.tracks.reduce((s, x) => s + x.notes.length, 0)} نوتة`));

  // التحكم بمستوى الصوت
  const volWrap = el('span', 'st-vol');
  volWrap.appendChild(el('span', '', '🔊'));
  const vol = el('input');
  vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = Math.round(st.volume * 100);
  vol.oninput = () => { st.volume = vol.value / 100; Engine.setVolume(st.volume); };
  volWrap.appendChild(vol);
  bar.appendChild(volWrap);

  const spacer = el('span', 'spacer'); bar.appendChild(spacer);

  const saveBtn = el('button', 'btn accent', '💾 تصدير MIDI');
  saveBtn.onclick = () => exportMIDI(t);
  bar.appendChild(saveBtn);
  box.appendChild(bar);

  /* --- المسارات (كتم + اختيار مسار التحرير) --- */
  const trackBar = el('div', 'st-tracks');
  st.data.tracks.forEach((tr, i) => {
    if (!tr.notes.length && i !== st.selTrack) return;
    const chip = el('span', 'st-track' + (st.muted.has(i) ? ' muted' : ''));
    const dot = el('span', 'dot'); dot.style.background = TRACK_COLORS[i % TRACK_COLORS.length];
    chip.appendChild(dot);
    chip.appendChild(el('span', '', `${tr.name} (${tr.notes.length})`));
    chip.title = 'انقر للكتم/الإلغاء';
    chip.onclick = () => { st.muted.has(i) ? st.muted.delete(i) : st.muted.add(i); renderStudio(t); };
    if (i === st.selTrack) chip.classList.add('sel');
    trackBar.appendChild(chip);
  });
  trackBar.appendChild(el('span', 'st-hint', 'انقر خلية في الشبكة لإضافة/حذف نوتة'));
  box.appendChild(trackBar);

  /* --- Piano Roll --- */
  const rollWrap = el('div', 'st-rollwrap');
  const canvas = el('canvas', 'st-roll');
  rollWrap.appendChild(canvas);
  box.appendChild(rollWrap);
  st.canvas = canvas;
  drawRoll(t);
  canvas.onclick = (e) => rollClick(t, e);

  /* --- مصفوفة الإيقاعات --- */
  const rhythm = el('div', 'st-rhythm');
  const rh = el('div', 'st-rhythm-head');
  rh.appendChild(el('h3', '', '🥁 مصفوفة الإيقاعات — أضف ضرباتك'));
  const clearBtn = el('button', 'btn small', 'مسح الكل');
  clearBtn.onclick = () => { for (const l of LANES) st.lanes[l.id].fill(false); renderStudio(t); };
  rh.appendChild(clearBtn);
  rhythm.appendChild(rh);

  const grid = el('div', 'st-grid');
  grid.style.setProperty('--steps', st.steps);
  for (const lane of LANES) {
    const row = el('div', 'st-lane');
    const lbl = el('button', 'st-lane-lbl', lane.label);
    lbl.title = 'استمع';
    lbl.onclick = () => { Engine.ensure(); Engine.kit[lane.id](Engine.now() + 0.02, 1); };
    row.appendChild(lbl);
    const cells = el('div', 'st-cells');
    for (let s = 0; s < st.steps; s++) {
      const c = el('button', 'st-cell' + (st.lanes[lane.id][s] ? ' on' : '') + (s % st.stepsPerBar === 0 ? ' bar' : s % 4 === 0 ? ' beat' : ''));
      c.dataset.step = s;
      c.onclick = () => {
        st.lanes[lane.id][s] = !st.lanes[lane.id][s];
        c.classList.toggle('on');
        if (st.lanes[lane.id][s]) { Engine.ensure(); Engine.kit[lane.id](Engine.now() + 0.02, 0.9); }
      };
      cells.appendChild(c);
    }
    row.appendChild(cells);
    grid.appendChild(row);
  }
  rhythm.appendChild(grid);
  box.appendChild(rhythm);
}

/* ================= رسم Piano Roll ================= */
function rollGeometry(st) {
  const pitches = new Set();
  st.data.tracks.forEach((tr) => tr.notes.forEach((n) => pitches.add(n.pitch)));
  if (!pitches.size) { pitches.add(36); pitches.add(48); }
  const min = Math.max(0, Math.min(...pitches) - 1);
  const max = Math.min(127, Math.max(...pitches) + 1);
  const rows = [];
  for (let p = max; p >= min; p--) rows.push(p);
  const pxStep = 22, rowH = 16, labelW = 44;
  return { rows, min, max, pxStep, rowH, labelW, W: labelW + st.steps * pxStep, H: rows.length * rowH };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (p) => NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1);

function drawRoll(t, playTick = -1) {
  const st = t.st;
  const g = rollGeometry(st);
  st.geo = g;
  const c = st.canvas;
  const dpr = window.devicePixelRatio || 1;
  c.width = g.W * dpr; c.height = g.H * dpr;
  c.style.width = g.W + 'px'; c.style.height = g.H + 'px';
  const x = c.getContext('2d');
  x.scale(dpr, dpr);

  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--bg').trim() || '#0f1420';
  const border = css.getPropertyValue('--border').trim() || '#2a3450';
  const muted = css.getPropertyValue('--muted').trim() || '#8ea0c9';

  x.fillStyle = bg; x.fillRect(0, 0, g.W, g.H);

  // صفوف
  g.rows.forEach((p, r) => {
    const y = r * g.rowH;
    x.fillStyle = (p % 12 === 1 || p % 12 === 3 || p % 12 === 6 || p % 12 === 8 || p % 12 === 10)
      ? 'rgba(127,127,160,0.06)' : 'transparent';
    x.fillRect(g.labelW, y, g.W, g.rowH);
    x.strokeStyle = border; x.globalAlpha = 0.35;
    x.beginPath(); x.moveTo(0, y + 0.5); x.lineTo(g.W, y + 0.5); x.stroke();
    x.globalAlpha = 1;
    x.fillStyle = muted; x.font = '9px monospace'; x.textBaseline = 'middle'; x.textAlign = 'left';
    x.fillText(noteName(p) + ' ' + p, 3, y + g.rowH / 2);
  });

  // أعمدة الخطوات (حدود البارات حسب الميزان)
  for (let s = 0; s <= st.steps; s++) {
    const xx = g.labelW + s * g.pxStep;
    x.strokeStyle = border;
    x.globalAlpha = s % st.stepsPerBar === 0 ? 0.9 : s % 4 === 0 ? 0.5 : 0.2;
    x.beginPath(); x.moveTo(xx + 0.5, 0); x.lineTo(xx + 0.5, g.H); x.stroke();
  }
  x.globalAlpha = 1;

  // النوتات
  st.data.tracks.forEach((tr, i) => {
    if (st.muted.has(i)) return;
    x.fillStyle = TRACK_COLORS[i % TRACK_COLORS.length];
    for (const n of tr.notes) {
      const r = g.rows.indexOf(n.pitch);
      if (r < 0) continue;
      const nx = g.labelW + (n.tick / st.stepTicks) * g.pxStep;
      const nw = Math.max(3, (n.dur / st.stepTicks) * g.pxStep - 1);
      x.globalAlpha = 0.55 + 0.45 * (n.vel / 127);
      x.fillRect(nx, r * g.rowH + 2, nw, g.rowH - 4);
    }
  });
  x.globalAlpha = 1;

  // ضربات المصفوفة (تظهر أيضاً على الرول كمؤشرات أسفل)
  // مؤشر التشغيل
  if (playTick >= 0) {
    const px = g.labelW + (playTick / st.stepTicks) * g.pxStep;
    x.strokeStyle = '#ff5c72'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(px, 0); x.lineTo(px, g.H); x.stroke();
    x.lineWidth = 1;
  }
}

function rollClick(t, e) {
  const st = t.st;
  const g = st.geo;
  const rect = st.canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (cx < g.labelW) return;
  const step = Math.floor((cx - g.labelW) / g.pxStep);
  const row = Math.floor(cy / g.rowH);
  const pitch = g.rows[row];
  if (pitch == null || step < 0 || step >= st.steps) return;

  const tr = st.data.tracks[st.selTrack];
  if (!tr) return;
  const tick = step * st.stepTicks;
  // نوتة موجودة تغطي هذه الخلية؟ → حذف
  const idx = tr.notes.findIndex((n) => n.pitch === pitch && n.tick < tick + st.stepTicks && n.tick + n.dur > tick);
  if (idx >= 0) tr.notes.splice(idx, 1);
  else {
    tr.notes.push({ tick, dur: st.stepTicks, pitch, vel: 100, ch: tr.notes[0] ? tr.notes[0].ch : 9 });
    tr.notes.sort((a, b) => a.tick - b.tick);
    Engine.ensure(); Engine.perc(Engine.now() + 0.02, pitch, 100);
  }
  st.dirty = true;
  st.data.totalTicks = Math.max(st.data.totalTicks, tick + st.stepTicks);
  drawRoll(t);
}

/* ================= التشغيل ================= */
function collectEvents(st) {
  const evs = [];
  st.data.tracks.forEach((tr, i) => {
    if (st.muted.has(i)) return;
    for (const n of tr.notes) evs.push({ tick: n.tick, pitch: n.pitch, vel: n.vel, kind: 'perc' });
  });
  for (const lane of LANES) {
    st.lanes[lane.id].forEach((on, s) => {
      if (on) evs.push({ tick: s * st.stepTicks, kind: lane.id, vel: 110 });
    });
  }
  evs.sort((a, b) => a.tick - b.tick);
  return evs;
}

function loopTicks(st) {
  let end = st.data.totalTicks;
  for (const lane of LANES) {
    st.lanes[lane.id].forEach((on, s) => { if (on) end = Math.max(end, (s + 1) * st.stepTicks); });
  }
  // الحلقة تُقفل على حدود البار حسب الميزان (3/4 أو 4/4…)
  const barTicks = st.stepTicks * st.stepsPerBar;
  return Math.max(barTicks, Math.ceil(end / barTicks) * barTicks);
}

function startPlay(t) {
  const st = t.st;
  Engine.ensure();
  Engine.setVolume(st.volume);
  st.playing = true;
  st.events = collectEvents(st);
  st.loopEnd = loopTicks(st);
  st.startTime = Engine.now() + 0.08;
  st.evIdx = 0;
  const spt = () => st.tempo / 1e6 / st.data.division; // ثانية لكل تكّة

  st.timer = setInterval(() => {
    const horizon = Engine.now() + 0.15;
    while (true) {
      if (st.evIdx >= st.events.length) {
        if (st.loop && st.events.length) { st.startTime += st.loopEnd * spt(); st.evIdx = 0; continue; }
        break;
      }
      const e = st.events[st.evIdx];
      const when = st.startTime + e.tick * spt();
      if (when > horizon) break;
      if (when >= Engine.now() - 0.02) {
        if (e.kind === 'perc') Engine.perc(when, e.pitch, e.vel);
        else Engine.kit[e.kind](when, e.vel / 127);
      }
      st.evIdx++;
    }
    if (!st.loop && st.evIdx >= st.events.length && Engine.now() > st.startTime + st.loopEnd * spt()) {
      stopPlay(t);
    }
  }, 30);

  const anim = () => {
    if (!st.playing) return;
    const cur = (Engine.now() - st.startTime) / spt();
    const tickNow = st.loop ? ((cur % st.loopEnd) + st.loopEnd) % st.loopEnd : cur;
    drawRoll(t, Math.max(0, tickNow));
    const step = Math.floor(tickNow / st.stepTicks);
    highlightStep(step);
    if (st.posEl && step >= 0) {
      const barN = Math.floor(step / st.stepsPerBar) + 1;
      const beatN = Math.floor((step % st.stepsPerBar) / 4) + 1;
      st.posEl.textContent = `${barN} : ${beatN}`;
    }
    st.raf = requestAnimationFrame(anim);
  };
  st.raf = requestAnimationFrame(anim);
  const pb = document.querySelector('.st-play');
  if (pb) pb.textContent = '⏹ إيقاف';
}

function stopPlay(t) {
  stopStudioPlayback(t);
  drawRoll(t);
  highlightStep(-1);
  if (t.st.posEl) t.st.posEl.textContent = '1 : 1';
  const pb = document.querySelector('.st-play');
  if (pb) pb.textContent = '▶ تشغيل';
}

function highlightStep(s) {
  document.querySelectorAll('.st-cell.playhead').forEach((c) => c.classList.remove('playhead'));
  if (s >= 0) document.querySelectorAll(`.st-cell[data-step="${s}"]`).forEach((c) => c.classList.add('playhead'));
}

/* ================= التصدير ================= */
async function exportMIDI(t) {
  const st = t.st;
  const tracks = st.data.tracks.map((tr) => ({ name: tr.name, notes: tr.notes }));
  // مسار الإيقاعات المضافة (قناة 10 — GM Drums)
  const rhythmNotes = [];
  for (const lane of LANES) {
    st.lanes[lane.id].forEach((on, s) => {
      if (on) rhythmNotes.push({ tick: s * st.stepTicks, dur: Math.max(1, st.stepTicks >> 1), pitch: lane.gm, vel: 110, ch: 9 });
    });
  }
  if (rhythmNotes.length) {
    rhythmNotes.sort((a, b) => a.tick - b.tick);
    tracks.push({ name: 'KON Rhythm', notes: rhythmNotes });
  }
  const bytes = MIDI.buildMIDI({ division: st.data.division, tempo: st.tempo, timeSig: st.data.timeSig, tracks });

  const dir = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/') + 1) : '';
  const base = t.name.replace(/\.(midi?|MIDI?)$/, '');
  const target = prompt('حفظ باسم:', `${dir}${base}_KON.midi`);
  if (!target) return;
  try {
    await api('/api/upload?path=' + encodeURIComponent(target), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    st.dirty = false;
    toast(`تم التصدير ✓ ${target} (${bytes.length} بايت${rhythmNotes.length ? ` + ${rhythmNotes.length} ضربة إيقاع` : ''})`, 'ok');
    await loadTree();
  } catch (e) { toast(e.message, 'err'); }
}
