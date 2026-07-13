/* midi.js — محلّل وباني ملفات MIDI القياسية (SMF)
 * يعمل في المتصفح وفي Node (للاختبار). */
(function (global) {
  'use strict';

  /** يفكّ ملف MIDI من Uint8Array */
  function parseMIDI(buf) {
    let p = 0;
    const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(buf[p + i]); p += n; return s; };
    const u32 = () => { const v = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]; p += 4; return v >>> 0; };
    const u16 = () => { const v = (buf[p] << 8) | buf[p + 1]; p += 2; return v; };
    const u8 = () => buf[p++];
    const vlq = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

    if (str(4) !== 'MThd') throw new Error('ليس ملف MIDI صالحاً (لا يبدأ بـ MThd)');
    const hlen = u32();
    const format = u16();
    const ntrks = u16();
    const division = u16();
    p += hlen - 6;

    const tracks = [];
    let tempo = 500000; // ميكروثانية لكل نوتة ربع (120 BPM افتراضياً)
    let tempoSet = false;
    let totalTicks = 0;

    for (let t = 0; t < ntrks && p + 8 <= buf.length; t++) {
      const id = str(4);
      const len = u32();
      const end = p + len;
      if (id !== 'MTrk') { p = end; continue; }

      let tick = 0, status = 0, name = '';
      const notes = [];
      const open = {}; // نوتات مفتوحة بانتظار note-off

      while (p < end) {
        tick += vlq();
        let b = u8();
        if (b < 0x80) { p--; b = status; } else status = b;
        const type = b & 0xf0, ch = b & 0x0f;

        if (b === 0xff) { // meta
          const mt = u8(); const ml = vlq(); const ds = p;
          if (mt === 0x51 && ml === 3) {
            const tv = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
            if (!tempoSet) { tempo = tv; tempoSet = true; }
          } else if (mt === 0x03 && !name) {
            let s = ''; for (let i = 0; i < ml; i++) s += String.fromCharCode(buf[p + i]);
            name = s;
          }
          p = ds + ml;
        } else if (b === 0xf0 || b === 0xf7) { // sysex
          p += vlq();
        } else if (type === 0x90) {
          const pitch = u8(), vel = u8();
          const key = pitch + '_' + ch;
          if (vel > 0) open[key] = { tick, pitch, vel, ch };
          else if (open[key]) {
            const o = open[key];
            notes.push({ tick: o.tick, dur: Math.max(1, tick - o.tick), pitch, vel: o.vel, ch });
            delete open[key];
          }
        } else if (type === 0x80) {
          const pitch = u8(); u8();
          const key = pitch + '_' + ch;
          if (open[key]) {
            const o = open[key];
            notes.push({ tick: o.tick, dur: Math.max(1, tick - o.tick), pitch, vel: o.vel, ch });
            delete open[key];
          }
        } else if (type === 0xc0 || type === 0xd0) { u8(); }
        else { u8(); u8(); }
      }
      // أغلق أي نوتات معلّقة
      for (const k in open) {
        const o = open[k];
        notes.push({ tick: o.tick, dur: Math.max(1, division >> 2), pitch: o.pitch, vel: o.vel, ch: o.ch });
      }
      notes.sort((a, b2) => a.tick - b2.tick || a.pitch - b2.pitch);
      const tmax = notes.reduce((m, n) => Math.max(m, n.tick + n.dur), tick);
      totalTicks = Math.max(totalTicks, tmax);
      tracks.push({ name: name || `مسار ${t + 1}`, notes });
      p = end;
    }

    return { format, division, tempo, bpm: Math.round(60000000 / tempo), tracks, totalTicks };
  }

  /** يبني ملف MIDI (تنسيق 1) من {division, tempo, tracks:[{name, notes:[{tick,dur,pitch,vel,ch}]}]} */
  function buildMIDI(data) {
    const vlqBytes = (v) => {
      const out = [v & 0x7f]; v >>>= 7;
      while (v > 0) { out.unshift((v & 0x7f) | 0x80); v >>>= 7; }
      return out;
    };
    const u32b = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    const u16b = (v) => [(v >>> 8) & 0xff, v & 0xff];

    const trackBytes = (tr, withTempo) => {
      const evs = [];
      if (withTempo) {
        evs.push({ tick: 0, ord: 0, bytes: [0xff, 0x51, 0x03, (data.tempo >> 16) & 0xff, (data.tempo >> 8) & 0xff, data.tempo & 0xff] });
      }
      if (tr.name) {
        const nb = [...tr.name].map((c) => c.charCodeAt(0) & 0x7f).slice(0, 100);
        evs.push({ tick: 0, ord: 0, bytes: [0xff, 0x03, nb.length, ...nb] });
      }
      for (const n of tr.notes) {
        const ch = (n.ch || 0) & 0x0f;
        evs.push({ tick: n.tick, ord: 1, bytes: [0x90 | ch, n.pitch & 0x7f, (n.vel || 100) & 0x7f] });
        evs.push({ tick: n.tick + Math.max(1, n.dur | 0), ord: 2, bytes: [0x80 | ch, n.pitch & 0x7f, 0] });
      }
      evs.sort((a, b) => a.tick - b.tick || a.ord - b.ord);
      const out = [];
      let last = 0;
      for (const e of evs) { out.push(...vlqBytes(e.tick - last)); last = e.tick; out.push(...e.bytes); }
      out.push(0x00, 0xff, 0x2f, 0x00);
      return out;
    };

    const bytes = [0x4d, 0x54, 0x68, 0x64, ...u32b(6), ...u16b(1), ...u16b(data.tracks.length), ...u16b(data.division)];
    data.tracks.forEach((tr, i) => {
      const tb = trackBytes(tr, i === 0);
      bytes.push(0x4d, 0x54, 0x72, 0x6b, ...u32b(tb.length), ...tb);
    });
    return new Uint8Array(bytes);
  }

  const api = { parseMIDI, buildMIDI };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.MIDI = api;
})(typeof window !== 'undefined' ? window : globalThis);
