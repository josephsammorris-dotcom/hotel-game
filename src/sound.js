// Hotel — all the game's audio, synthesised live with the Web Audio API (no sound files):
// an upbeat looping soundtrack, lively effects, notification chimes and engine/tyre sounds for the cars.
// Exposes window.Sound. Everything is silent until the first tap or key press (browsers require a gesture).
(function () {
  'use strict';
  const LS = 'hotelAudio';
  const prefs = Object.assign({ music: true, sfx: true, musicVol: 0.55, sfxVol: 0.85 }, (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } })());
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch (e) {} };

  let an = null, fwBus = null, ctx = null, master, comp, musicBus, sfxBus, uiBus, carBus, ambBus, verb, verbSend, noiseBuf, pinkBuf;
  const now = () => ctx.currentTime;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const R = (a, b) => a + Math.random() * (b - a);

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ctx = new AC({ latencyHint: 'interactive' });
    comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
    const trim = ctx.createGain(); trim.gain.value = 0.8;
    master = ctx.createGain(); master.gain.value = 0.75; master.connect(comp); comp.connect(trim); trim.connect(lim); lim.connect(ctx.destination);
    an = ctx.createAnalyser(); an.fftSize = 2048; lim.connect(an);
    musicBus = ctx.createGain(); sfxBus = ctx.createGain(); uiBus = ctx.createGain(); carBus = ctx.createGain(); ambBus = ctx.createGain();
    for (const b of [musicBus, sfxBus, uiBus, carBus, ambBus]) b.connect(master);
    // fireworks get their own bus with a compressor, so a whole show of bangs stays clean
    fwBus = ctx.createGain(); fwBus.gain.value = 1; const fwComp = ctx.createDynamicsCompressor(); fwComp.threshold.value = -20; fwComp.ratio.value = 6; fwComp.knee.value = 6; fwComp.attack.value = 0.003; fwComp.release.value = 0.25; fwBus.connect(fwComp); fwComp.connect(sfxBus);
    // a small room reverb, shared
    verb = ctx.createConvolver(); verb.buffer = impulse(1.6, 2.6); verbSend = ctx.createGain(); verbSend.gain.value = 0.22; verbSend.connect(verb); verb.connect(master);
    // noise sources
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    pinkBuf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate); { const d = pinkBuf.getChannelData(0); let b0 = 0, b1 = 0, b2 = 0; for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b0 = 0.997 * b0 + w * 0.029591; b1 = 0.985 * b1 + w * 0.032534; b2 = 0.95 * b2 + w * 0.048056; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.6; } }
    applyPrefs();
    loadSamples();
    ambience();
    if (prefs.music) Music.start();
    document.addEventListener('visibilitychange', () => { if (!ctx) return; if (document.hidden) ctx.suspend(); else ctx.resume(); });
  }
  function impulse(sec, decay) { const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate); for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); } return b; }
  function applyPrefs() {
    if (!ctx) return;
    const t = now();
    musicBus.gain.setTargetAtTime(prefs.music ? 0.42 * prefs.musicVol : 0, t, 0.15);
    for (const [b, k] of [[sfxBus, 0.55], [uiBus, 0.5], [carBus, 0.8], [ambBus, 0.6]]) b.gain.setTargetAtTime(prefs.sfx ? k * prefs.sfxVol : 0, t, 0.08);
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(e => document.addEventListener(e, init, { passive: true }));

  // ---------------------------------------------------------------- building blocks
  function out(dest, pan, wet) {
    // returns an input node routed (optionally panned, optionally with reverb) to dest
    let n = ctx.createGain(), head = n;
    if (pan) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); n.connect(p); n = p; }
    n.connect(dest); if (wet) { const s = ctx.createGain(); s.gain.value = wet; n.connect(s); s.connect(verbSend); }
    return head;
  }
  function tone(o) {
    // o: {type, f, f2, t, dur, g, a, r, dest, pan, wet, detune, lp, q, vib, vibRate, wave}
    const t = o.t !== undefined ? o.t : now(), dur = o.dur || 0.2, a = o.a !== undefined ? o.a : 0.005, r = o.r !== undefined ? o.r : dur * 0.8;
    const osc = ctx.createOscillator(); if (o.wave) osc.setPeriodicWave(o.wave); else osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t); if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), t + (o.glide || dur));
    if (o.detune) osc.detune.value = o.detune;
    let node = osc;
    if (o.vib) { const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = o.vibRate || 5.5; lg.gain.value = o.vib; l.connect(lg); lg.connect(osc.frequency); l.start(t); l.stop(t + dur + r + 0.05); }
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(o.lp, t); if (o.lp2) f.frequency.exponentialRampToValueAtTime(o.lp2, t + dur); f.Q.value = o.q || 0.7; node.connect(f); node = f; }
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(o.g || 0.2, t + a);
    g.gain.setValueAtTime(o.g || 0.2, t + Math.max(a, dur - r)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.02);
    node.connect(g); g.connect(out(o.dest || sfxBus, o.pan, o.wet));
    osc.start(t); osc.stop(t + dur + 0.1);
    return osc;
  }
  function noise(o) {
    // o: {t, dur, g, a, r, type, f, f2, q, dest, pan, wet, pink, rate}
    const t = o.t !== undefined ? o.t : now(), dur = o.dur || 0.2, a = o.a !== undefined ? o.a : 0.003;
    const src = ctx.createBufferSource(); src.buffer = o.pink ? pinkBuf : noiseBuf; src.loop = true; if (o.rate) src.playbackRate.value = o.rate;
    let node = src;
    if (o.type) { const f = ctx.createBiquadFilter(); f.type = o.type; f.frequency.setValueAtTime(o.f || 1000, t); if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + dur); f.Q.value = o.q || 0.8; node.connect(f); node = f; }
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(o.g || 0.2, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g); g.connect(out(o.dest || sfxBus, o.pan, o.wet));
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }
  // a bell/chime: two inharmonic partials
  function bell(f, t, g, dur, dest, pan) { tone({ f, t, dur: dur || 0.9, g, a: 0.002, r: (dur || 0.9) * 0.95, dest, pan, wet: 0.5 }); tone({ f: f * 2.76, t, dur: (dur || 0.9) * 0.5, g: g * 0.35, a: 0.001, dest, pan, wet: 0.5 }); tone({ f: f * 5.4, t, dur: (dur || 0.9) * 0.25, g: g * 0.12, a: 0.001, dest, pan, wet: 0.4 }); }
  const ok = () => ctx && prefs.sfx && ctx.state === 'running';
  const distGain = d => d === undefined ? 1 : Math.max(0.2, Math.min(1, 9 / Math.max(1, d)));

  // ---------------------------------------------------------------- music: a smooth, confident groove — upbeat but businesslike
  // (electric piano with seventh chords, round bass, light swung drums, a vibraphone tune)
  const Music = (() => {
    const BPM = 102, STEP = 60 / BPM / 4, SWING = 0.16; // swung 16ths
    let playing = false, timer = null, nextT = 0, step = 0;
    const CH = { Fmaj7: [53, 57, 60, 64], Dm7: [50, 53, 57, 60], Gm7: [53, 55, 58, 62], C7: [52, 55, 58, 60], Bbmaj7: [53, 57, 58, 62], C7sus: [53, 55, 58, 60], Am7: [52, 55, 57, 60] };
    const ROOT = { Fmaj7: 41, Dm7: 38, Gm7: 43, C7: 36, Bbmaj7: 46, C7sus: 36, Am7: 45 };
    const PROG = ['Fmaj7', 'Dm7', 'Gm7', 'C7', 'Fmaj7', 'Dm7', 'Bbmaj7', 'C7sus', 'Bbmaj7', 'Am7', 'Gm7', 'C7', 'Am7', 'Dm7', 'Gm7', 'C7'];
    const n = s => { const m = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }; return 12 * (+s.slice(-1) + 1) + m[s[0]] + (s[1] === '#' ? 1 : s[1] === 'b' ? -1 : 0); };
    const MEL = [
      [[0, 'A5', 3], [4, 'C6', 2], [6, 'A5', 2], [8, 'G5', 4]],
      [[0, 'F5', 3], [4, 'A5', 2], [6, 'F5', 2], [8, 'E5', 3], [12, 'D5', 2]],
      [[0, 'D5', 2], [2, 'F5', 2], [4, 'Bb5', 3], [8, 'A5', 2], [10, 'G5', 4]],
      [[0, 'E5', 3], [4, 'G5', 2], [6, 'Bb5', 2], [8, 'A5', 6]],
      [[0, 'C6', 3], [4, 'A5', 2], [6, 'C6', 2], [8, 'D6', 3], [12, 'C6', 2]],
      [[0, 'A5', 4], [6, 'F5', 2], [8, 'A5', 4]],
      [[0, 'D6', 3], [4, 'C6', 2], [6, 'Bb5', 2], [8, 'A5', 4]],
      [[0, 'G5', 8]],
      [[0, 'F5', 2], [2, 'A5', 2], [4, 'D6', 3], [10, 'C6', 2], [12, 'A5', 3]],
      [[0, 'G5', 2], [2, 'E5', 2], [4, 'C6', 3], [10, 'A5', 4]],
      [[0, 'Bb5', 3], [4, 'A5', 2], [6, 'G5', 2], [8, 'F5', 3], [12, 'D5', 2]],
      [[0, 'E5', 2], [2, 'G5', 2], [4, 'Bb5', 2], [6, 'D6', 2], [8, 'C6', 6]],
      [[0, 'E5', 3], [4, 'G5', 2], [6, 'A5', 2], [8, 'C6', 4]],
      [[0, 'A5', 4], [4, 'F5', 2], [6, 'D5', 2], [8, 'F5', 4]],
      [[0, 'D6', 2], [2, 'Bb5', 2], [4, 'G5', 3], [10, 'A5', 2], [12, 'Bb5', 2]],
      [[0, 'A5', 4], [4, 'G5', 3], [8, 'E5', 6]]
    ];
    let cycle = 0; // how many times round the 16 bars (the tune sits out the first time through the A section)
    function kick(t, g) { tone({ f: 110, f2: 46, glide: 0.1, t, dur: 0.28, g: 0.55 * g, a: 0.002, r: 0.24, dest: musicBus }); }
    function rim(t, g) { noise({ t, dur: 0.05, g: 0.12 * g, type: 'bandpass', f: 2600, q: 3, dest: musicBus, wet: 0.35 }); tone({ type: 'triangle', f: 820, t, dur: 0.035, g: 0.06 * g, dest: musicBus }); }
    function snare(t, g) { noise({ t, dur: 0.16, g: 0.13 * g, type: 'bandpass', f: 1700, q: 0.7, dest: musicBus, wet: 0.4 }); }
    function hat(t, g) { noise({ t, dur: 0.03, g: 0.045 * g, type: 'highpass', f: 8000, dest: musicBus, pan: 0.3 }); }
    function shaker(t, g) { noise({ t, dur: 0.05, g: 0.022 * g, type: 'bandpass', f: 6000, q: 1, dest: musicBus, pan: -0.3, a: 0.02 }); }
    function bass(t, m, len) { tone({ type: 'triangle', f: mtof(m), t, dur: len, g: 0.26, a: 0.006, r: len * 0.5, lp: 700, dest: musicBus }); tone({ type: 'sine', f: mtof(m), t, dur: len, g: 0.16, a: 0.006, r: len * 0.5, dest: musicBus }); }
    function rhodes(t, chord, len, g) { chord.forEach((m, k) => { const f = mtof(m); tone({ f, t, dur: len, g: 0.045 * g, a: 0.004, r: len * 0.7, dest: musicBus, pan: (k - 1.5) * 0.25, wet: 0.45, vib: f * 0.004, vibRate: 4.5 }); tone({ f: f * 2, t, dur: Math.min(len, 0.25), g: 0.018 * g, a: 0.002, r: 0.2, dest: musicBus, pan: (k - 1.5) * 0.25 }); tone({ f: f * 7, t, dur: 0.05, g: 0.004 * g, a: 0.001, dest: musicBus }); }); }
    function vibes(t, m, len) { const f = mtof(m), d = Math.max(0.5, len); tone({ f, t, dur: d, g: 0.07, a: 0.003, r: d * 0.9, dest: musicBus, pan: 0.15, wet: 0.5, vib: f * 0.006, vibRate: 5 }); tone({ f: f * 4, t, dur: 0.18, g: 0.015, a: 0.001, dest: musicBus, pan: 0.15, wet: 0.4 }); }
    function schedule(t, s) {
      const bar = Math.floor(s / 16) % 16, i = s % 16, name = PROG[bar], chord = CH[name], root = ROOT[name];
      if (bar === 0 && i === 0 && s > 0) cycle++;
      // drums: kick on 1 and the "and" of 3, rim on 2 and 4 (a soft snare in the B half), swung hats, a quiet shaker
      if (i === 0 || i === 10) kick(t, i ? 0.8 : 1);
      if (i === 4 || i === 12) { if (bar >= 8) snare(t, 0.9); rim(t, 1); }
      if (i % 2 === 0) hat(t, i % 4 === 2 ? 1 : 0.6);
      shaker(t, i % 4 === 2 ? 1 : 0.5);
      // bass: root, a push before beat 3, the fifth, and a walk into the next bar
      const next = ROOT[PROG[(bar + 1) % 16]];
      const pat = { 0: [root, 3], 3: [root, 1], 6: [root + 7, 2], 10: [root + 12, 2], 14: [next + (next > root ? -1 : 1), 2] };
      if (pat[i]) bass(t, pat[i][0], STEP * pat[i][1] * 0.95);
      // electric piano: a held chord on 1, syncopated pushes
      if (i === 0) rhodes(t, chord, STEP * 5, 1);
      if (i === 7 || i === 11) rhodes(t, chord, STEP * 2.5, 0.7);
      // the tune: rests the first time through the opening, then plays
      if (!(cycle === 0 && bar < 8)) for (const [st, note, len] of MEL[bar]) if (st === i) vibes(t, n(note), len * STEP);
    }
    // ---- the victory track: brighter, faster, straight beat, brass fanfare over four-on-the-floor
    let mode = 'game';
    const WSTEP = 60 / 126 / 4;
    const WCH = { C: [60, 64, 67], F: [60, 65, 69], G: [59, 62, 67], Am: [57, 60, 64], Dm: [57, 62, 65], E: [56, 59, 64] };
    const WROOT = { C: 36, F: 41, G: 43, Am: 45, Dm: 38, E: 40 };
    const WPROG = ['C', 'F', 'G', 'C', 'Am', 'F', 'Dm', 'G'];
    const WMEL = [
      [[0, 'G4', 2], [2, 'C5', 2], [4, 'E5', 2], [6, 'G5', 4], [12, 'E5', 2], [14, 'G5', 2]],
      [[0, 'A5', 4], [4, 'G5', 2], [6, 'F5', 2], [8, 'A5', 6]],
      [[0, 'B5', 2], [2, 'A5', 2], [4, 'G5', 2], [6, 'D5', 2], [8, 'G5', 4], [12, 'B5', 4]],
      [[0, 'C6', 6], [8, 'G5', 2], [10, 'E5', 2], [12, 'C5', 4]],
      [[0, 'A5', 2], [2, 'C6', 2], [4, 'E6', 4], [8, 'D6', 2], [10, 'C6', 2], [12, 'A5', 4]],
      [[0, 'F5', 2], [2, 'A5', 2], [4, 'C6', 4], [8, 'A5', 2], [10, 'F5', 2], [12, 'C6', 4]],
      [[0, 'D6', 3], [4, 'C6', 2], [6, 'A5', 2], [8, 'F5', 2], [10, 'A5', 2], [12, 'D6', 4]],
      [[0, 'B5', 2], [2, 'D6', 2], [4, 'G6', 6], [12, 'G5', 1], [13, 'A5', 1], [14, 'B5', 2]]
    ];
    function brass(t, m, len, g, pan) { const f = mtof(m); tone({ type: 'sawtooth', f, t, dur: len, g: 0.05 * g, a: 0.02, r: Math.min(0.15, len * 0.4), lp: 1400, lp2: 3200, q: 1.5, vib: f * 0.005, vibRate: 5.5, dest: musicBus, pan: pan || 0, wet: 0.35 }); tone({ type: 'sawtooth', f: f * 1.003, t, dur: len, g: 0.035 * g, a: 0.025, r: Math.min(0.15, len * 0.4), lp: 2200, dest: musicBus, pan: -(pan || 0), wet: 0.35 }); }
    function scheduleWin(t, s) {
      const bar = Math.floor(s / 16) % 8, i = s % 16, name = WPROG[bar], chord = WCH[name], root = WROOT[name];
      if (i % 4 === 0) kick(t, 1.1);
      if (i === 4 || i === 12) { snare(t, 1.2); noise({ t, dur: 0.1, g: 0.12, type: 'bandpass', f: 1400, q: 1.2, dest: musicBus, wet: 0.4 }); }
      hat(t, i % 2 ? 0.7 : 1.1);
      if (i === 0 && bar % 4 === 0) noise({ t, dur: 1.4, g: 0.1, type: 'highpass', f: 5000, dest: musicBus, wet: 0.5 });
      if (i % 2 === 0) bass(t, root + (i % 4 === 2 ? 12 : 0), WSTEP * 1.7);
      if (i === 0 || i === 6 || i === 10) chord.forEach((m, k) => brass(t, m, WSTEP * (i === 0 ? 3 : 1.5), 0.55, (k - 1) * 0.4));
      for (const [st, note, len] of WMEL[bar]) if (st === i) { brass(t, n(note), len * WSTEP * 0.95, 1.5, 0.05); vibes(t, n(note) + 12, len * WSTEP); }
    }
    function tick() {
      if (mode === 'win') { while (nextT < now() + 0.12) { scheduleWin(nextT, step); nextT += WSTEP; step++; } return; }
      while (nextT < now() + 0.12) { schedule(nextT + (step % 2 ? STEP * SWING : 0), step); nextT += STEP; step++; }
    }
    return {
      start() { if (!ctx || playing) return; playing = true; nextT = now() + 0.1; step = 0; cycle = 0; timer = setInterval(tick, 25); },
      stop() { playing = false; clearInterval(timer); },
      setMode(m) { if (m === mode) return; mode = m; step = 0; cycle = 0; if (ctx) nextT = Math.max(nextT, now() + 0.05); },
      get playing() { return playing; }, get step() { return step; }
    };
  })();

  // ---------------------------------------------------------------- ambience: rain and wind follow the weather
  let amb = null;
  function ambience() {
    const mk = (type, f, q) => { const s = ctx.createBufferSource(); s.buffer = pinkBuf; s.loop = true; const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; s.connect(fl); fl.connect(g); g.connect(ambBus); s.start(); return { g, fl }; };
    amb = { rain: mk('highpass', 1800, 0.5), wind: mk('bandpass', 500, 0.6) };
  }
  function setWeather(e) {
    if (!amb || !e) return; const t = now();
    amb.rain.g.gain.setTargetAtTime((e.rain || 0) * 0.16, t, 1.2);
    amb.wind.g.gain.setTargetAtTime((e.wind || 0) * 0.12, t, 1.5);
    amb.wind.fl.frequency.setTargetAtTime(380 + (e.wind || 0) * 500, t, 2);
  }

  // ---------------------------------------------------------------- recorded samples (window.SOUND_DATA, embedded in the page)
  const BUF = {};
  function loadSamples() {
    const D = window.SOUND_DATA || {};
    for (const [k, url] of Object.entries(D)) {
      try {
        const b64 = url.slice(url.indexOf(',') + 1), bin = atob(b64), u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        ctx.decodeAudioData(u8.buffer).then(b => { BUF[k] = b; }, () => {});
      } catch (e) {}
    }
  }
  const pick = (...names) => names[Math.floor(Math.random() * names.length)];
  // play a sample: {t, rate, gain, pan, dest, wet, offset, dur, loop, lp, fadeIn, fadeOut}
  function play(name, o) {
    o = o || {}; const b = BUF[name]; if (!b) return null;
    const t = o.t !== undefined ? o.t : now(), s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = o.rate || 1; s.loop = !!o.loop;
    let node = s;
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; node.connect(f); node = f; }
    const g = ctx.createGain(), gv = o.gain === undefined ? 1 : o.gain;
    if (o.fadeIn) { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gv, t + o.fadeIn); } else g.gain.value = gv;
    if (o.dur) { const end = t + o.dur, fo = o.fadeOut || 0.08; g.gain.setValueAtTime(gv, Math.max(t + (o.fadeIn || 0), end - fo)); g.gain.linearRampToValueAtTime(0.0001, end); }
    node.connect(g); g.connect(out(o.dest || sfxBus, o.pan, o.wet));
    s.start(t, o.offset || 0);
    if (o.dur) s.stop(t + o.dur + 0.05);
    return { s, g };
  }

  // ---------------------------------------------------------------- the cars: a recorded racing straight-six (engine samples at 1000–8000 rpm,
  // cross-faded and pitched to the exact revs), recorded tyre screech on launch and at the stop
  const cars = {};
  const CAR_LEVEL = 0.7;
  function carVoice(i) {
    if (cars[i]) return cars[i];
    if (!BUF.eng1) return null;
    const t = now(), c = {};
    c.pan = ctx.createStereoPanner(); c.out = ctx.createGain(); c.out.gain.value = 0; c.out.connect(c.pan); c.pan.connect(carBus);
    const vs = ctx.createGain(); vs.gain.value = 0.06; c.out.connect(vs); vs.connect(verbSend);
    c.lp = ctx.createBiquadFilter(); c.lp.type = 'lowpass'; c.lp.frequency.value = 4000; c.lp.Q.value = 0.6;
    c.load = ctx.createGain(); c.load.gain.value = 0.8; c.lp.connect(c.load); c.load.connect(c.out);
    c.layers = [];
    for (let k = 1; k <= 8; k++) {
      const s = ctx.createBufferSource(); s.buffer = BUF['eng' + k]; s.loop = true; const g = ctx.createGain(); g.gain.value = 0;
      s.connect(g); g.connect(c.lp); s.start(t, Math.random() * 1.2); c.layers.push({ s, g, rpm: k * 1000 });
    }
    c.gear = 1; c.phase = ''; c.braked = false; c.skid = null;
    return (cars[i] = c);
  }
  function setRpm(c, rpm, load, t, k) {
    k = k || 0.04; rpm = Math.max(900, Math.min(8200, rpm));
    const pos = Math.max(1, Math.min(8, rpm / 1000)), lo = Math.floor(pos), f = pos - lo;
    c.layers.forEach((L, j) => {
      const n = j + 1, w = n === lo ? Math.cos(f * Math.PI / 2) : n === lo + 1 ? Math.sin(f * Math.PI / 2) : 0;
      L.g.gain.setTargetAtTime(w, t, k);
      if (w > 0 || Math.abs(n - pos) < 2) L.s.playbackRate.setTargetAtTime(rpm / L.rpm, t, k);
    });
    c.lp.frequency.setTargetAtTime(1400 + load * 6500, t, k);
    c.load.gain.setTargetAtTime(0.55 + load * 0.45, t, k);
  }
  function skid(c, t, amount, dur, rate0, rate1) {
    if (!BUF.skid) return;
    if (c.skid) { try { c.skid.s.stop(t + 0.03); } catch (e) {} }
    const p = play('skid', { t, dest: c.out, gain: amount * 0.45, rate: rate0, offset: Math.random() * 1.2, dur, fadeIn: 0.05, fadeOut: Math.min(0.3, dur * 0.5), lp: 3200 });
    if (p) { p.s.playbackRate.setValueAtTime(rate0, t); p.s.playbackRate.linearRampToValueAtTime(rate1, t + dur); c.skid = p; }
  }
  const GEARS = [[0, 0.3], [0.3, 0.58], [0.58, 0.85], [0.85, 1.3]];
  function carFrame(d, first) {
    if (!ctx) return;
    const c = carVoice(d.i); if (!c) return;
    const t = now(), u = Math.max(0, d.v / Math.max(0.1, d.vmax));
    const vol = CAR_LEVEL * (d.driver ? 1.1 : Math.max(0.15, Math.min(1, 6 / Math.max(1, d.dist))) * (d.onScreen ? 1 : 0.5));
    c.pan.pan.setTargetAtTime(d.driver ? 0 : d.pan * 0.8, t, 0.05);
    if (first) {
      c.out.gain.cancelScheduledValues(t); c.out.gain.setValueAtTime(0.0001, t); c.out.gain.linearRampToValueAtTime(vol, t + 0.08);
      setRpm(c, 1100, 0.2, t, 0.005); setRpm(c, 6200, 1, t + 0.06, 0.06); // blip and launch
      skid(c, t + 0.05, 0.4, 0.3, 1.0, 0.92); // a brief wheelspin chirp
      c.gear = 1; c.phase = 'accel'; c.braked = false;
      return;
    }
    c.out.gain.setTargetAtTime(vol, t, 0.1);
    let g = 1; while (g < GEARS.length && u > GEARS[g - 1][1]) g++;
    c.gear = g;
    const [lo, hi] = GEARS[g - 1], x = Math.max(0, Math.min(1, (u - lo) / (hi - lo)));
    const load = d.phase === 'accel' ? 1 : d.phase === 'cruise' ? 0.55 : 0.15;
    const rpm = d.phase === 'brake' ? 1600 + u * 3600 : 3200 + x * 4600;
    setRpm(c, rpm, load, t, d.phase === 'brake' ? 0.08 : 0.04);
    // braking hard to the stop: a full tyre screech
    if (d.phase === 'brake' && !c.braked && d.left < 0.8) { c.braked = true; skid(c, t + Math.max(0, d.left - 0.45), 0.8, 0.5, 0.98, 0.84); }
    c.phase = d.phase;
  }
  function carStop(d) {
    if (!ctx) return; const c = cars[d.i]; if (!c) return; const t = now();
    if (!c.braked) skid(c, t, 0.55, 0.32, 0.96, 0.86); // even a short hop ends with a little squeal
    setRpm(c, 1000, 0.1, t, 0.12);
    c.out.gain.setTargetAtTime(0, t + 0.8, 0.22);
    clearTimeout(c.off); c.off = setTimeout(() => { if (c.out.gain.value < 0.01) { try { c.layers.forEach(L => L.s.stop()); } catch (e) {} delete cars[d.i]; } }, 2600);
  }

  // ---------------------------------------------------------------- effects (recorded samples, with a touch of synthesis for beeps and sparkle)
  const coins = (t, k, g, pan) => { for (let j = 0; j < k; j++) play(pick('coin_k', 'coin_pickup'), { t: t + j * R(0.05, 0.09), rate: R(0.9, 1.15), gain: g * R(0.4, 0.7), pan: (pan || 0) + R(-0.2, 0.2), wet: 0.2 }); };
  const FX = {
    // menus
    click() { play('click_001', { gain: 0.9, dest: uiBus }); },
    select() { play(pick('select_001', 'select_002'), { gain: 0.7, dest: uiBus }); },
    toggle() { play(pick('toggle_001', 'toggle_002'), { gain: 0.6, dest: uiBus }); },
    open() { play('open_001', { gain: 0.6, dest: uiBus }); },
    close() { play('close_001', { gain: 0.6, dest: uiBus }); },
    back() { play('back_001', { gain: 0.7, dest: uiBus }); },
    attention() { play('maximize_003', { gain: 0.3, dest: uiBus }); },
    // dice: a rattle of hits across the felt, then the settle
    // dice: a wooden die rolling across a wooden tray — low and soft, not clicky
    dice() { const t = now(); play('surface_wood_tray1', { t, gain: 0.4, rate: R(0.75, 0.85), lp: 2200 }); let tt = t; for (let k = 0; k < 7; k++) { tt += R(0.07, 0.12) * (1 + k * 0.1); play(pick('dicehit_wood1', 'dicehit_wood2', 'dicehit_wood3', 'dicehit_wood4', 'dicehit_wood6'), { t: tt, rate: R(0.62, 0.78), gain: R(0.3, 0.55), pan: R(-0.25, 0.25), lp: 2600 }); } },
    diceLand() { const t = now(); play(pick('dicehit_wood7', 'dicehit_wood9'), { t, gain: 0.7, rate: 0.62, lp: 2400 }); play('dicehit_wood12', { t: t + 0.12, gain: 0.35, rate: 0.7, lp: 2400 }); },
    // the planning spinner: a ratchet that slows to a stop, then the committee's verdict
    // the planning spinner: a soft whir of a wheel turning, and a few gentle wooden clicks only as it comes to rest
    spinStart() {
      if (FX._whir || !ok()) return; const t = now();
      const src = ctx.createBufferSource(); src.buffer = pinkBuf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 520; f.Q.value = 1.1;
      const am = ctx.createGain(); am.gain.value = 0.6; const lfo = ctx.createOscillator(); lfo.frequency.value = 7; const lg = ctx.createGain(); lg.gain.value = 0.35; lfo.connect(lg); lg.connect(am.gain);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16, t + 0.25);
      src.connect(f); f.connect(am); am.connect(g); g.connect(out(sfxBus, 0, 0.2)); src.start(t); lfo.start(t);
      FX._whir = { src, lfo, g, f };
    },
    spinSettle(result) {
      if (!ok()) return; const t0 = now(), T = 2.0;
      if (!FX._whir) FX.spinStart();
      const w = FX._whir; FX._whir = null;
      if (w) { w.lfo.frequency.setValueAtTime(7, t0); w.lfo.frequency.exponentialRampToValueAtTime(1.2, t0 + T); w.f.frequency.setValueAtTime(520, t0); w.f.frequency.exponentialRampToValueAtTime(260, t0 + T); w.g.gain.setValueAtTime(0.16, t0); w.g.gain.linearRampToValueAtTime(0.0001, t0 + T); w.src.stop(t0 + T + 0.1); w.lfo.stop(t0 + T + 0.1); }
      [1.05, 1.32, 1.58, 1.8, 1.97].forEach((d, k) => play(pick('dicehit_wood1', 'dicehit_wood3', 'dicehit_wood6'), { t: t0 + d, gain: 0.22 + k * 0.03, rate: 0.55, lp: 1800 }));
      if (result) setTimeout(() => FX.verdict(result), T * 1000 + 80); // otherwise the caller plays the verdict when the needle really stops
    },
    verdict(r) {
      if (!ok()) return; const t = now();
      if (r === 'green') { play('confirmation_002', { t, gain: 0.5 }); play('ding', { t: t + 0.12, gain: 0.28, wet: 0.3 }); }
      else if (r === 'H') { play('maximize_003', { t, gain: 0.7 }); play('ding', { t: t + 0.1, gain: 0.5, rate: 1.26, wet: 0.4 }); play('glass_001', { t: t + 0.3, gain: 0.5, rate: 1.2 }); play('ding', { t: t + 0.42, gain: 0.4, rate: 1.5, wet: 0.5 }); }
      else if (r === '2') { play('question_001', { t, gain: 0.7 }); coins(t + 0.35, 5, 1); }
      else play('trombone', { t, gain: 0.55 });
    },
    // money
    cashIn(o) { if (!ok()) return; const t = now(), pan = o && o.pan; play('ding', { t, gain: 0.35, pan, wet: 0.25 }); coins(t + 0.08, 6, 0.7, pan); },
    cashOut() { if (!ok()) return; const t = now(); coins(t, 3, 0.8); play('drop_002', { t: t + 0.18, gain: 0.5, rate: 0.75 }); },
    buyLand() { if (!ok()) return; const t = now(); play('placement_b', { t, gain: 0.9, rate: 0.7 }); play('impact_small', { t, gain: 0.3, rate: 1.3, dur: 0.3 }); play('confirmation_001', { t: t + 0.18, gain: 0.7 }); },
    takeover() { if (!ok()) return; const t = now(); play('impact_big', { t, gain: 0.8, rate: 0.85 }); play('placement_c', { t, gain: 0.9, rate: 0.6 }); play('error_006', { t: t + 0.25, gain: 0.5, rate: 0.8 }); },
    entrance(o) { if (!ok()) return; const t = now(); play('drop_002', { t, gain: 0.7, pan: o && o.pan }); play('confirmation_001', { t: t + 0.15, gain: 0.55, rate: 1.15 }); },
    gavel(n) { if (!ok()) return; const t = now(); for (let k = 0; k < (n || 1); k++) { play("dicehit_wood5", { t: t + k * 0.32, gain: 2.2, rate: 0.5 }); play('placement_c', { t: t + k * 0.32, gain: 0.8, rate: 0.55 }); } },
    demolish() { if (!ok()) return; const t = now(); play('fw_boom2', { t, gain: 0.4, rate: 0.6, lp: 1200 }); ['removal_a', 'removal_b', 'removal_c', 'removal_d'].forEach((n, k) => play(n, { t: t + 0.1 + k * 0.18, gain: 0.7, rate: R(0.7, 0.9) })); },
    debt() { if (!ok()) return; play('beeps', { gain: 0.8 }); },
    bankrupt() { if (!ok()) return; const t = now(); play('impact_big', { t, gain: 0.8, rate: 0.7 }); play('trombone', { t: t + 0.3, gain: 0.55 }); },
    win() { if (!ok()) return; const t = now(); play('confirmation_002', { t, gain: 0.9 }); play('maximize_003', { t: t + 0.3, gain: 0.8 }); [1, 1.26, 1.5, 2].forEach((r, k) => play('ding', { t: t + 0.5 + k * 0.16, gain: 0.45, rate: r, wet: 0.4 })); coins(t + 0.6, 10, 1); play('fw_crowd_cheer', { t: t + 0.4, gain: 0.32, wet: 0.2 }); },
    // construction while the cranes are up: the crane's diesel, its reversing beeper, hammering, a ratchet and the odd clank
    buildStart(o) {
      if (!ok()) return; const t0 = now(); if (FX._lastBuild && t0 - FX._lastBuild < 0.4) return; FX._lastBuild = t0;
      const gg = Math.max(0.65, distGain(o && o.dist)) * 1.5, pan = (o && o.pan * 0.5) || 0, T = 2.3;
      play('truck_engine', { t: t0, loop: true, rate: 0.7, gain: 0.7 * gg, pan, dur: T, fadeIn: 0.2, fadeOut: 0.35, lp: 1400 }); // the crane's diesel
      for (let k = 0; k < 4; k++) tone({ type: 'square', f: 1040, t: t0 + 0.15 + k * 0.5, dur: 0.22, g: 0.05 * gg, a: 0.005, r: 0.02, lp: 2400, pan: pan + 0.25 }); // reversing beeper
      let tt = t0 + 0.1; while (tt < t0 + T - 0.15) { // hammering
        play(pick('placement_a', 'placement_b', 'placement_c', 'placement_d'), { t: tt, gain: R(0.8, 1.2) * gg, rate: R(0.75, 1.05), pan: pan + R(-0.15, 0.15) });
        play('dicehit_wood5', { t: tt, gain: R(0.5, 0.8) * gg, rate: R(0.45, 0.6), pan });
        tt += R(0.16, 0.3);
      }
      for (const a of [0.5, 1.3, 1.9]) play('impact_small', { t: t0 + a, gain: 0.7 * gg, rate: R(1.0, 1.3), pan: pan - 0.2, dur: 0.6, wet: 0.35 }); // steel clanks
      for (let k = 0; k < 8; k++) play('rotate', { t: t0 + 0.95 + k * 0.055, gain: 0.8 * gg, rate: 0.9 + k * 0.03, pan: pan + 0.2 }); // a ratchet
    },
    buildDone(o) { if (!ok()) return; const t = now(), gg = Math.max(0.65, distGain(o && o.dist)), pan = o && o.pan * 0.7; play('placement_d', { t, gain: 0.8 * gg, rate: 0.8, pan }); play('confirmation_002', { t: t + 0.08, gain: 0.5 * gg, pan }); play('glass_001', { t: t + 0.25, gain: 0.35 * gg, pan, rate: 1.1 }); },
    drop(o) { if (!ok()) return; play('placement_a', { gain: 0.6 * distGain(o && o.dist), rate: 0.8, pan: o && o.pan * 0.7 }); },
    // fireworks: a whistle as each rocket climbs, then a real bang
    // fireworks (real recordings): the rocket's whoosh, the burst, and crackle on the bigger shells
    fwLaunch(o) { if (!ok()) return; const t = now(); if (FX._lastWhoosh && t - FX._lastWhoosh < 0.18) return; FX._lastWhoosh = t; play('fw_whoosh', { gain: 0.2 * distGain(o.dist), rate: R(0.9, 1.1), pan: o.pan * 0.8, lp: 6000, dest: fwBus }); },
    fwBurst(o) {
      if (!ok()) return; const t = now(), lvl = o.level || 1, gg = distGain(o.dist), pan = o.pan * 0.8;
      FX._bursts = (FX._bursts || []).filter(x => t - x < 0.7); const n = FX._bursts.length; if (n >= 3) return; FX._bursts.push(t);
      const k = 1 / (1 + n * 0.6); // bangs that land on top of each other are quieter
      play(pick('fw_boom1', 'fw_boom2', 'fw_boom3'), { t, gain: Math.min(0.5, (0.26 + 0.05 * lvl) * gg) * k, rate: R(0.92, 1.08), pan, wet: 0.3, dest: fwBus });
      if (lvl >= 2 && Math.random() < 0.5) play('fw_crackle', { t: t + R(0.25, 0.5), gain: 0.2 * gg * k, rate: R(0.9, 1.1), pan: pan + R(-0.2, 0.2), wet: 0.25, dest: fwBus });
      if (musicBus && prefs.music) { musicBus.gain.cancelScheduledValues(t); musicBus.gain.setTargetAtTime(0.42 * prefs.musicVol * 0.45, t, 0.05); musicBus.gain.setTargetAtTime(0.42 * prefs.musicVol, t + 1.6, 0.6); }
    },
    // landing at someone else's hotel: a hotel reception bell, then an 'uh-oh'
    stayAlert() { if (!ok()) return; const t = now(); play('ding', { t, gain: 0.45, rate: 1.4, wet: 0.3 }); play('ding', { t: t + 0.14, gain: 0.35, rate: 1.4, wet: 0.3 }); play('question_001', { t: t + 0.35, gain: 0.5 }); },
    // notifications by kind
    notify(kind) {
      if (!ok()) return; const t = now();
      if (kind === 'good') play('confirmation_001', { t, gain: 0.3, dest: uiBus });
      else if (kind === 'great') { play('maximize_003', { t, gain: 0.35, dest: uiBus }); play('ding', { t: t + 0.1, gain: 0.2, dest: uiBus, wet: 0.3 }); }
      else if (kind === 'bad') play('error_006', { t, gain: 0.7, dest: uiBus });
      else play('glass_001', { t, gain: 0.45, dest: uiBus });
    },
    landed(type) {
      if (!ok()) return; const t = now();
      play('switch_002', { t, gain: 0.35, dest: uiBus });
      if (type === 'freeEntrance' || type === 'freeBuild') { play('maximize_003', { t: t + 0.1, gain: 0.35, dest: uiBus }); play('ding', { t: t + 0.2, gain: 0.18, rate: 1.5, dest: uiBus, wet: 0.4 }); }
      else if (type === 'build') play('question_001', { t: t + 0.1, gain: 0.4, dest: uiBus });
      else play('glass_001', { t: t + 0.1, gain: 0.35, dest: uiBus });
    }
  };
  function kickish(t) { tone({ f: 120, f2: 50, t, dur: 0.25, g: 0.35 }); }

  // a player's recorded greeting (a data: URL from their phone): decoded once, quiet start trimmed, levelled, music dipped under it
  const VOICE = new Map();
  async function voiceBuf(url) {
    if (VOICE.has(url)) return VOICE.get(url);
    const p = (async () => {
      const b64 = url.slice(url.indexOf(',') + 1), bin = atob(b64), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const buf = await ctx.decodeAudioData(u8.buffer);
      let peak = 0, start = buf.length, end = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; if (v > 0.03) { if (i < start) start = i; if (i > end) end = i; } } }
      if (start >= end) { start = 0; end = buf.length; }
      const sr = buf.sampleRate, from = Math.max(0, start / sr - 0.06), to = Math.min(buf.duration, end / sr + 0.25);
      return { buf, from, dur: Math.min(4.3, Math.max(0.2, to - from)), gain: Math.min(5, 0.8 / Math.max(peak, 0.02)) };
    })();
    VOICE.set(url, p); p.catch(() => VOICE.delete(url));
    if (VOICE.size > 12) VOICE.delete(VOICE.keys().next().value);
    return p;
  }
  async function voice(url, delay) {
    if (!ok() || !url) return 0;
    let v; try { v = await voiceBuf(url); } catch (e) { return 0; }
    const t = now() + (delay || 0), src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = v.buf; g.gain.value = v.gain * 1.1; src.connect(g); g.connect(sfxBus); src.start(t, v.from, v.dur);
    if (musicBus && prefs.music) { const m = 0.42 * prefs.musicVol; musicBus.gain.cancelScheduledValues(t); musicBus.gain.setTargetAtTime(m * 0.25, t - 0.1, 0.08); musicBus.gain.setTargetAtTime(m, t + v.dur + 0.2, 0.5); }
    return v.dur;
  }

  // public
  const api = {
    init, voice,
    play(name, arg) { if (!ok()) return; const f = FX[name]; if (f) try { f(arg); } catch (e) { console.error(e); } },
    ui(name) { if (!ok()) return; const f = FX[name] || FX.click; try { f(); } catch (e) {} },
    // from the 3D board
    board(name, d) {
      if (!ok()) return;
      if (name === 'carStart') carFrame(d, true); else if (name === 'car') carFrame(d, false); else if (name === 'carStop') carStop(d);
      else if (FX[name]) FX[name](d);
    },
    weather: setWeather,
    get prefs() { return Object.assign({}, prefs); },
    set(key, val) { prefs[key] = val; save(); applyPrefs(); if (key === 'music' && ctx) { if (val) Music.start(); else Music.stop(); } },
    toggleMute() { if (prefs.music || prefs.sfx) { prefs.was = { music: prefs.music, sfx: prefs.sfx }; api.set('music', false); api.set('sfx', false); } else { const w = prefs.was || { music: true, sfx: true }; api.set('sfx', w.sfx !== false); api.set('music', w.music !== false); } return prefs.music || prefs.sfx; },
    level() { if (!an) return 0; const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); let r = 0, pk = 0; for (const x of d) { r += x * x; pk = Math.max(pk, Math.abs(x)); } return { rms: Math.sqrt(r / d.length), peak: pk }; },
    victory(on) { Music.setMode(on ? 'win' : 'game'); if (on && ctx && !Music.playing && prefs.music) Music.start(); },
    get musicStep() { return Music.step; }, get musicPlaying() { return Music.playing; },
    get running() { return !!ctx && ctx.state === 'running'; }
  };
  // Sound sources (all free to use; attribution given where the licence asks for it)
  api.credits = [
    'Engine: "b-i6r" racing straight-six samples by CryHam, Stunt Rally 3 (made with engine-sim) — CC BY 4.0',
    'Tyre skid, coins, construction placement/removal, rotate: Kenney starter kits — MIT',
    'Menu and notification sounds: Kenney Interface Sounds / UI Audio — CC0',
    'Dice: @3d-dice/dice-box-threejs — MIT',
    'Fireworks (boom, rocket whoosh, crackle) and crowd cheer: recordings by vialgames, ReadeOnly, Rudmer_Rotteveel, j1987 and SoundCollectah on freesound.org — CC0',
    'Ding (MatthewWong), Sad Trombone (kirbydx), Negative Beeps (themusicalnomad) via the Godot demo projects — CC0',
    'Crane diesel, impacts: Godot demo projects — MIT',
    'Music: composed and synthesised for this game'
  ];
  window.Sound = api;
})();
