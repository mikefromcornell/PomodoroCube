/* ============================================================================
 * PomodoroCube — app.js
 * A dependency-free virtual pomodoro cube timer.
 *
 * Timing model (the important part):
 *   - The countdown is computed from an ABSOLUTE wall-clock deadline
 *     (Date.now() based), never by counting ticks. So nothing accumulates
 *     drift, no matter how long it runs.
 *   - A Web Worker drives 100 ms ticks so the timer keeps ticking while the
 *     background tab is throttled (falls back to setInterval when a Worker
 *     is unavailable, e.g. inside a sandboxed iframe preview).
 *   - Every pending event (50 / 75 / 90 %, time calls, final ticks, finish)
 *     ALSO gets a precise setTimeout aimed exactly at its target instant, so
 *     alerts fire within a few milliseconds while the tab is awake.
 *   - If the tab was frozen / the device slept, missed events are caught up
 *     the moment we run again, and the lateness is measured and reported in
 *     the Accuracy panel instead of being silently ignored.
 * ========================================================================= */
(() => {
  'use strict';

  /* ---------------------------------------------------------------- helpers */
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const MIN = 60000;

  /* ------------------------------------------------------- safe local store */
  /* localStorage throws in sandboxed iframes / private mode — degrade to RAM. */
  const storage = (() => {
    let live = false;
    try {
      const k = '__pc_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      live = true;
    } catch (_) { live = false; }
    const mem = Object.create(null);
    return {
      get live() { return live; },
      read(key, fallback) {
        try {
          const raw = live ? localStorage.getItem(key) : mem[key];
          if (raw == null) return fallback;
          const val = JSON.parse(raw);
          if (val && typeof val === 'object' && !Array.isArray(val) && fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
            return Object.assign({}, fallback, val);
          }
          return val;
        } catch (_) { return fallback; }
      },
      write(key, value) {
        try {
          const raw = JSON.stringify(value);
          if (live) localStorage.setItem(key, raw); else mem[key] = raw;
        } catch (_) {}
      },
      remove(key) { try { if (live) localStorage.removeItem(key); else delete mem[key]; } catch (_) {} }
    };
  })();

  const KEY_SETTINGS = 'pomodorocube.settings.v1';
  const KEY_SESSION  = 'pomodorocube.session.v1';

  /* ------------------------------------------------------------- settings */
  const DEFAULT_SETTINGS = {
    /* alerts */
    alertHalf: true, alert75: true, alert90: true,
    sound: true, volume: 0.7,
    voice: true, voiceURI: '', voiceRate: 1,
    toast: true, notify: false, vibrate: true,
    tickFinal: true, repeatFinish: false,
    /* extra time calls while running: minutes (0 = off) */
    announceEvery: 5, announceOnReturn: true,
    /* session */
    focusMin: 30, shortMin: 5, longMin: 15,
    autoStartBreak: false, keepAwake: true, restoreSession: true, rememberLast: false,
    /* ui */
    theme: 'auto'
  };
  const settings = Object.assign({}, DEFAULT_SETTINGS, storage.read(KEY_SETTINGS, {}));
  const saveSettings = () => storage.write(KEY_SETTINGS, settings);

  /* ------------------------------------------------------------ app state */
  const PHASES = {
    focus: { label: 'Focus',  settingKey: 'focusMin', fallback: 30 },
    short: { label: 'Break',  settingKey: 'shortMin', fallback: 5 },
    long:  { label: 'Long break', settingKey: 'longMin', fallback: 15 }
  };
  const PRESETS = [5, 10, 15, 20, 25, 30, 45, 50, 60];

  const state = {
    phase: 'focus',
    status: 'idle',        // idle | running | paused | finished
    totalMs: 30 * MIN,     // full length of the current run
    startAt: 0,            // epoch ms when the run began (marks are relative to this)
    deadline: 0,           // epoch ms when it ends  ← source of truth
    pausedRemaining: 0,
    fired: new Set(),
    lastAnnounce: 0,
    setMode: false,
    draft: { min: 30, sec: 0 },
    editField: 'min'
  };

  const diag = { engine: '—', tickMs: 100, gapMax: 0, lateMax: 0, lateCount: 0, gaps: 0, jumps: 0 };

  /* Optional observer: set hooks.onEvent = fn to receive every alert with its
     exact target time, actual fire time and lateness in ms. */
  const hooks = { onEvent: null, onFinish: null };
  let lastTickWall = 0, lastTickPerf = 0, lastRenderAt = 0, titleTimer = null, repeatTimer = null, flashTimer = null;

  const phaseWord = () => (state.phase === 'focus' ? 'focus' : 'break');
  const phaseDuration = (phase = state.phase) => {
    const p = PHASES[phase] || PHASES.focus;
    const v = Number(settings[p.settingKey]);
    return clamp(Number.isFinite(v) && v > 0 ? v : p.fallback, 1 / 60, 12 * 60) * MIN;
  };

  /* ---------------------------------------------------------- time helpers */
  /** "MM:SS" for the 7-segment display (ceil so it reads 30:00 at the start). */
  function clock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60), s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  /** Spoken-friendly duration: "15 minutes 30 seconds". */
  function human(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60), s = total % 60;
    const out = [];
    if (m) out.push(m + ' minute' + (m === 1 ? '' : 's'));
    if (s || !m) out.push(s + ' second' + (s === 1 ? '' : 's'));
    return out.join(' ');
  }
  const pct = (v) => Math.round(v * 100) + '%';

  /* ------------------------------------------------------------- audio fx */
  let actx = null, master = null;
  function audioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      if (!actx) {
        actx = new AC({ latencyHint: 'interactive' });
        master = actx.createGain();
        master.gain.value = clamp(settings.volume, 0, 1) * 0.9;
        master.connect(actx.destination);
      }
      if (actx.state === 'suspended' && actx.resume) actx.resume();
      return actx;
    } catch (_) { return null; }
  }
  function tone(freq, when, dur, opts) {
    const c = actx; if (!c) return;
    opts = opts || {};
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = opts.type || 'triangle';
    osc.frequency.setValueAtTime(freq, when);
    const peak = opts.gain == null ? 0.45 : opts.gain;
    const atk = opts.attack == null ? 0.008 : opts.attack;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(dur, atk + 0.02));
    osc.connect(g); g.connect(master);
    osc.start(when);
    osc.stop(when + dur + 0.06);
  }
  const CHIMES = {
    half:     (t) => { tone(659.25, t, 0.55, { gain: 0.42 }); tone(880, t + 0.17, 0.9, { gain: 0.36 }); },
    p75:      (t) => { [659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.15, 0.55, { gain: 0.4 })); },
    p90:      (t) => { [1174.66, 1174.66, 1567.98].forEach((f, i) => tone(f, t + i * 0.13, 0.2, { gain: 0.32, type: 'square', attack: 0.003 })); },
    finish:   (t) => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.16, 0.75, { gain: 0.4 }));
      tone(261.63, t + 0.62, 1.7, { gain: 0.26, type: 'sine' });
      tone(392.0, t + 0.62, 1.5, { gain: 0.16, type: 'sine' });
    },
    announce: (t) => { tone(987.77, t, 0.36, { gain: 0.28 }); tone(1318.51, t + 0.13, 0.5, { gain: 0.24 }); },
    tick:     (t, freq) => { tone(freq || 1046.5, t, 0.05, { gain: 0.22, type: 'square', attack: 0.002 }); },
    ui:       (t) => { tone(880, t, 0.09, { gain: 0.22 }); },
    set:      (t) => { tone(659.25, t, 0.12, { gain: 0.3 }); tone(987.77, t + 0.11, 0.2, { gain: 0.28 }); },
    cancel:   (t) => { tone(440, t, 0.12, { gain: 0.26 }); tone(329.63, t + 0.1, 0.22, { gain: 0.26 }); }
  };
  function play(name, arg) {
    if (!settings.sound) return;
    const c = audioContext();
    if (!c || !CHIMES[name]) return;
    try { CHIMES[name](c.currentTime + 0.015, arg); } catch (_) {}
  }

  /* --------------------------------------------------------------- speech */
  let voices = [];
  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    try {
      voices = window.speechSynthesis.getVoices() || [];
      const sel = $('#voiceSel');
      if (!sel) return;
      const prev = settings.voiceURI;
      const list = voices.filter(v => /^en/i.test(v.lang));
      const pool = list.length ? list : voices;
      sel.innerHTML = '';
      const auto = document.createElement('option');
      auto.value = ''; auto.textContent = 'System default voice';
      sel.appendChild(auto);
      pool.forEach(v => {
        const o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = `${v.name} — ${v.lang}${v.default ? ' (default)' : ''}`;
        sel.appendChild(o);
      });
      sel.value = prev || '';
      if (sel.value !== (prev || '')) sel.value = '';
    } catch (_) {}
  }
  function pickVoice() {
    if (!voices.length) return null;
    if (settings.voiceURI) {
      const found = voices.find(v => v.voiceURI === settings.voiceURI);
      if (found) return found;
    }
    const lang = (navigator.language || 'en-US');
    return voices.find(v => v.lang === lang) || voices.find(v => /^en/i.test(v.lang)) || null;
  }
  function speak(text, force) {
    if (!text) return;
    if (!settings.voice && !force) return;
    if (!('speechSynthesis' in window)) return;
    try {
      const synth = window.speechSynthesis;
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = navigator.language || 'en-US'; }
      u.rate = clamp(Number(settings.voiceRate) || 1, 0.5, 2);
      u.pitch = 1;
      u.volume = clamp(settings.volume, 0.15, 1);
      if (synth.speaking || synth.pending) {
        synth.cancel();
        setTimeout(() => { try { synth.speak(u); } catch (_) {} }, 70);
      } else {
        synth.speak(u);
      }
    } catch (_) {}
  }

  /* --------------------------------------------------------------- ticker */
  /* Web Worker keeps ticking when the tab is background-throttled. */
  const ticker = (() => {
    const INTERVAL = 100;
    let worker = null, intervalId = null;
    try {
      const src =
        'let id=null;' +
        'onmessage=function(e){var d=e.data||{};' +
        'if(d.cmd==="start"){if(id)clearInterval(id);id=setInterval(function(){postMessage("tick")},Math.max(20,d.interval||100));postMessage("started");}' +
        'else if(d.cmd==="stop"){if(id)clearInterval(id);id=null;}' +
        'else if(d.cmd==="interval"&&id){clearInterval(id);id=setInterval(function(){postMessage("tick")},Math.max(20,d.interval||100));}};';
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      const w = new Worker(url);
      w.onmessage = (e) => { if (e.data === 'tick') tick(); };
      worker = w;
      diag.engine = 'Web Worker · 100 ms';
    } catch (_) { worker = null; }
    if (!worker) { diag.engine = 'Main thread · 100 ms'; }
    return {
      start() {
        if (worker) { try { worker.postMessage({ cmd: 'start', interval: INTERVAL }); } catch (_) {} }
        else if (intervalId == null) { intervalId = setInterval(() => tick(), INTERVAL); }
      },
      stop() {
        if (worker) { try { worker.postMessage({ cmd: 'stop' }); } catch (_) {} }
        else if (intervalId != null) { clearInterval(intervalId); intervalId = null; }
      }
    };
  })();

  /* ------------------------------------------------------ SVG 7-seg display */
  const DW = 21, DH = 44, T = 5;
  const SEGMAP = {
    '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg',
    '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '',
    'E': 'adefg', 'r': 'eg', 'o': 'cdeg'
  };
  const hBarPts = (x, y) => [
    [x + T / 2, y], [x + DW - T / 2, y], [x + DW, y + T / 2],
    [x + DW - T / 2, y + T], [x + T / 2, y + T], [x, y + T / 2]
  ];
  const vBarPts = (x, y, h) => [
    [x + T / 2, y], [x + T, y + T / 2], [x + T, y + h - T / 2],
    [x + T / 2, y + h], [x, y + h - T / 2], [x, y + T / 2]
  ];
  function poly(points) {
    const el = document.createElementNS(NS, 'polygon');
    el.setAttribute('points', points.map(p => p.join(',')).join(' '));
    return el;
  }
  function buildDigit(parent, x) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', `translate(${x} 0)`);
    const geo = {
      a: hBarPts(0, 0),
      b: vBarPts(DW - T, 3.2, 15.4),
      c: vBarPts(DW - T, 25.6, 15.4),
      d: hBarPts(0, DH - T),
      e: vBarPts(0, 25.6, 15.4),
      f: vBarPts(0, 3.2, 15.4),
      g: hBarPts(0, (DH - T) / 2)
    };
    const segs = {};
    Object.keys(geo).forEach(k => {
      const p = poly(geo[k]);
      p.setAttribute('class', 'seg ' + k);
      segs[k] = p;
      g.appendChild(p);
    });
    parent.appendChild(g);
    return segs;
  }
  /* layout: [d0][d1] : [d2][d3]  → block is 101.5 wide, 44 tall, centred on x=50.75 */
  const LAYOUT = (() => {
    const pos = [0, DW + 3.5, DW * 2 + 14, DW * 3 + 17.5];
    const colonX = DW * 2 + 6;
    return { pos, colonX, width: DW * 4 + 17.5, center: (DW * 4 + 17.5) / 2 };
  })();

  const ui = {};
  function buildDisplay() {
    const ticks = $('#tickGroup');
    ui.ticks = [];
    for (let i = 0; i < 60; i++) {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', 0); l.setAttribute('y1', -79.5);
      l.setAttribute('x2', 0); l.setAttribute('y2', -66);
      l.setAttribute('class', 'tick');
      l.setAttribute('transform', `rotate(${i * 6})`);
      ticks.appendChild(l);
      ui.ticks.push(l);
    }
    const minG = $('#digitsMin'), secG = $('#digitsSec');
    ui.digits = [
      buildDigit(minG, LAYOUT.pos[0]),
      buildDigit(minG, LAYOUT.pos[1]),
      buildDigit(secG, LAYOUT.pos[2]),
      buildDigit(secG, LAYOUT.pos[3])
    ];
    const colon = $('#colon');
    [11.5, 26.5].forEach(y => {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', LAYOUT.colonX); r.setAttribute('y', y);
      r.setAttribute('width', 5.4); r.setAttribute('height', 5.4);
      r.setAttribute('rx', 1.3); r.setAttribute('class', 'colon-dot');
      colon.appendChild(r);
    });
    ui.colon = colon;
    ui.arc = $('#arc');
    ui.digitsGroup = $('#digits');
  }
  let lastDigitStr = '';
  function setDigits(str) {
    if (str === lastDigitStr) return;
    lastDigitStr = str;
    for (let i = 0; i < 4; i++) {
      const ch = str[i] || ' ';
      const on = SEGMAP[ch] || '';
      const segs = ui.digits[i];
      Object.keys(segs).forEach(k => segs[k].classList.toggle('on', on.indexOf(k) >= 0));
    }
  }

  /* --------------------------------------------------- events / alert marks */
  const MARK_TEXT = {
    half: {
      title: 'Halfway point',
      speech: (ctx) => `Halfway there. ${ctx.remainingWords} remaining in your ${ctx.phase}.`,
      body: (ctx) => `50% of the ${ctx.phase} has elapsed — ${ctx.clock} left.`
    },
    p75: {
      title: '75% elapsed',
      speech: (ctx) => `Seventy-five percent done. ${ctx.remainingWords} remaining.`,
      body: (ctx) => `Three quarters of the way through — ${ctx.clock} left.`
    },
    p90: {
      title: 'Final stretch · 90%',
      speech: (ctx) => `Ten percent left. ${ctx.remainingWords} remaining.`,
      body: (ctx) => `90% elapsed — only ${ctx.clock} to go.`
    }
  };
  function markDefs() {
    const out = [];
    if (settings.alertHalf) out.push({ id: 'half', p: 0.5 });
    if (settings.alert75) out.push({ id: 'p75', p: 0.75 });
    if (settings.alert90) out.push({ id: 'p90', p: 0.9 });
    out.push({ id: 'finish', p: 1 });
    return out;
  }
  /** Everything that can fire during the current run, with absolute epoch targets. */
  function events() {
    const out = [];
    if (state.status !== 'running' && state.status !== 'paused') return out;
    markDefs().forEach(m => out.push({ key: m.id, kind: 'mark', id: m.id, target: state.startAt + state.totalMs * m.p }));
    const every = Number(settings.announceEvery) || 0;
    if (every > 0) {
      const stepMs = clamp(every, 1, 120) * MIN;
      for (let off = stepMs; off < state.totalMs - 1500; off += stepMs) {
        out.push({ key: 'call@' + off, kind: 'call', target: state.startAt + off });
      }
    }
    if (settings.tickFinal) {
      for (let s = 10; s >= 1; s--) {
        out.push({ key: `tick@${s}@${Math.round(state.deadline)}`, kind: 'tick', id: 't' + s, target: state.deadline - s * 1000 });
      }
    }
    out.sort((a, b) => a.target - b.target);
    return out;
  }

  /* ------------------------------------------- precise scheduling (fire ms) */
  let preciseTimers = [], schedSig = '';
  function schedulePrecise(now) {
    const pending = events().filter(e => !state.fired.has(e.key) && e.target > now && (e.target - now) < 45000);
    const sig = pending.map(e => e.key + ':' + Math.round(e.target)).join('|');
    if (sig === schedSig) return;
    schedSig = sig;
    preciseTimers.forEach(clearTimeout);
    preciseTimers = pending.slice(0, 24).map(e =>
      setTimeout(() => tick(), Math.max(0, e.target - Date.now()))
    );
  }

  /* ------------------------------------------------------- the main tick */
  function tick() {
    const now = Date.now(), perf = performance.now();
    if (lastTickWall) {
      const gap = now - lastTickWall;
      const perfGap = perf - lastTickPerf;
      if (state.status === 'running') {
        if (gap > diag.gapMax) diag.gapMax = gap;
        if (gap > 1200) diag.gaps++;
        /* wall clock jumped vs. monotonic clock → NTP fix or manual change */
        if (Math.abs(gap - perfGap) > 800) diag.jumps++;
      }
    }
    lastTickWall = now; lastTickPerf = perf;

    if (state.status === 'running') {
      checkEvents(now);
      schedulePrecise(now);
      if (now - lastRenderAt >= 90) { lastRenderAt = now; render(now); }
    }
  }

  /** Fire every event whose target instant has passed (catch-up safe). */
  function checkEvents(now) {
    const due = events().filter(e => e.target <= now && !state.fired.has(e.key));
    if (!due.length) return;
    due.forEach(e => {
      state.fired.add(e.key);
      if (hooks.onEvent) {
        try { hooks.onEvent({ key: e.key, kind: e.kind, id: e.id, target: e.target, firedAt: now, late: Math.max(0, Math.round(now - e.target)) }); } catch (_) {}
      }
    });
    const finishEv = due.find(e => e.id === 'finish' && e.kind === 'mark');
    const pick = finishEv || due[due.length - 1];
    const late = Math.max(0, Math.round(now - pick.target));
    diag.lateMax = Math.max(diag.lateMax, late);
    if (late > 500 && pick.kind !== 'tick') diag.lateCount++;
    if (finishEv) { finishSession(pick.target, now); return; }
    if (pick.kind === 'tick') { play('tick', pick.id === 't3' || pick.id === 't2' || pick.id === 't1' ? 1568 : 1046.5); }
    else if (pick.kind === 'call') fireTimeCall(now);
    else fireMark(pick.id, now, late);
    persist();
  }

  function ctxWords(remainingMs) {
    return { remainingWords: human(remainingMs), clock: clock(remainingMs), phase: phaseWord() };
  }

  function fireMark(id, now, late) {
    const remainingMs = Math.max(0, state.deadline - now);
    const c = ctxWords(remainingMs);
    const def = MARK_TEXT[id];
    if (!def) return;
    play(id);
    speak(def.speech(c));
    notify(def.title, def.body(c));
    buzz(id === 'p90' ? [120, 60, 120, 60, 180] : [140, 70, 140]);
    if (settings.toast) toast({ title: def.title, msg: def.body(c), kind: 'alert', timeout: 9000 });
    live(`Alert ${id} fired ${late} ms after target. ${c.remainingWords} remaining.`);
  }

  function fireTimeCall(now) {
    const remainingMs = Math.max(0, state.deadline - now);
    const c = ctxWords(remainingMs);
    play('announce');
    speak(`${c.remainingWords} remaining.`);
    if (settings.toast) toast({ title: 'Time call', msg: `${c.clock} remaining in this ${c.phase}.`, kind: 'info', timeout: 6000 });
    notify('Time remaining', `${c.remainingWords} left in your ${c.phase}.`, true);
  }

  function finishSession(target, now) {
    state.status = 'finished';
    state.pausedRemaining = 0;
    schedSig = '';
    preciseTimers.forEach(clearTimeout); preciseTimers = [];
    ticker.stop();
    releaseWake();
    play('finish');
    const isFocus = state.phase === 'focus';
    const speech = isFocus
      ? `Time's up. Your ${Math.round(state.totalMs / MIN)} minute focus session is complete.`
      : `Break over. ${Math.round(state.totalMs / MIN)} minutes done — ready for the next focus session?`;
    speak(speech);
    notify("Time's up", speech, false);
    buzz([180, 90, 180, 90, 320]);
    flashTitle();
    if (settings.repeatFinish) startRepeatChime();
    const nextLabel = isFocus
      ? `Start ${Number(settings.shortMin)} min break`
      : `Start ${Number(settings.focusMin)} min focus`;
    if (settings.toast) {
      toast({
        title: isFocus ? "Time's up — focus complete" : 'Break finished',
        msg: isFocus
          ? `You focused for ${Math.round(state.totalMs / MIN)} minutes. Take a break.`
          : `Break complete. Time for ${Number(settings.focusMin)} minutes of focus.`,
        kind: 'done', timeout: 0,
        actions: [
          { label: nextLabel, primary: true, onClick: () => { dismissToasts(); startNextPhase(); } },
          { label: '+5 min', onClick: () => { dismissToasts(); startTimer(state.totalMs + 5 * MIN); } },
          { label: 'Dismiss', onClick: dismissToasts }
        ]
      });
    }
    if (hooks.onFinish) { try { hooks.onFinish({ target, firedAt: now, late: Math.max(0, Math.round(now - target)), totalMs: state.totalMs, phase: state.phase }); } catch (_) {} }
    persist();
    render();
    if (settings.autoStartBreak) setTimeout(() => { if (state.status === 'finished') { dismissToasts(); startNextPhase(); } }, 1500);
  }

  function startRepeatChime() {
    let n = 0;
    stopRepeatChime();
    repeatTimer = setInterval(() => {
      if (n++ > 12 || state.status !== 'finished') { stopRepeatChime(); return; }
      play('announce');
    }, 5000);
  }
  function stopRepeatChime() { if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; } }

  function flashTitle() {
    let flip = false;
    const base = 'PomodoroCube';
    clearInterval(flashTimer);
    flashTimer = setInterval(() => {
      flip = !flip;
      document.title = flip ? "⏰ TIME'S UP — PomodoroCube" : base;
    }, 750);
    const stop = () => {
      clearInterval(flashTimer); flashTimer = null;
      document.title = base;
      updateTitle(displayMs(Date.now()));   /* hand the title back in whatever state we are in */
    };
    ['pointerdown', 'keydown', 'visibilitychange'].forEach(ev => window.addEventListener(ev, stop, { once: true }));
    setTimeout(stop, 60000);
  }

  /* ------------------------------------------------------------ lifecycle */
  function startTimer(ms) {
    stopRepeatChime();
    audioContext(); /* unlock on the user gesture that starts the timer */
    const total = clamp(ms == null ? phaseDuration() : ms, 1000, 12 * 60 * MIN);
    state.totalMs = total;
    state.startAt = Date.now();
    state.deadline = state.startAt + total;
    state.pausedRemaining = 0;
    state.status = 'running';
    state.fired = new Set();
    schedSig = '';
    ticker.start();
    requestWake();
    const c = ctxWords(total);
    if (settings.voice) speak(`${c.phase === 'focus' ? 'Focus' : 'Break'} started. ${human(total)}${c.phase === 'focus' ? ' of focus' : ''} on the clock.`);
    render();
    persist();
  }
  function pauseTimer() {
    if (state.status !== 'running') return;
    state.pausedRemaining = Math.max(0, state.deadline - Date.now());
    state.status = 'paused';
    schedSig = '';
    preciseTimers.forEach(clearTimeout); preciseTimers = [];
    ticker.stop(); releaseWake();
    play('ui');
    render();
    persist();
  }
  function resumeTimer() {
    if (state.status !== 'paused') return;
    const now = Date.now();
    state.startAt = now - (state.totalMs - state.pausedRemaining);
    state.deadline = now + state.pausedRemaining;
    state.status = 'running';
    schedSig = '';
    ticker.start(); requestWake();
    play('ui');
    render();
    persist();
  }
  function toggleRun() {
    if (state.setMode) { confirmSet(); return; }
    if (state.status === 'running') pauseTimer();
    else if (state.status === 'paused') resumeTimer();
    /* Idle or finished: run exactly the preset the cube is showing. Passing
       state.totalMs keeps the display authoritative — deriving the length from
       settings here is what used to make a 35:00 preset run as 30:00. */
    else startTimer(state.totalMs);
  }
  function resetTimer(silent) {
    stopRepeatChime();
    clearInterval(flashTimer); flashTimer = null;
    document.title = 'PomodoroCube';
    state.status = 'idle';
    state.fired = new Set();
    state.pausedRemaining = 0;
    state.deadline = 0; state.startAt = 0;
    state.totalMs = phaseDuration();
    schedSig = '';
    preciseTimers.forEach(clearTimeout); preciseTimers = [];
    ticker.stop(); releaseWake();
    if (!silent) play('cancel');
    render();
    persist();
  }
  function setPhase(phase, quiet) {
    if (!PHASES[phase]) return;
    state.phase = phase;
    resetTimer(true);
    if (!quiet) {
      play('ui');
      if (settings.toast) toast({ title: PHASES[phase].label, msg: `${human(state.totalMs)} ${phase === 'focus' ? 'of focus' : 'break'} ready.`, kind: 'info', timeout: 3500 });
    }
  }
  function startNextPhase() {
    setPhase(state.phase === 'focus' ? 'short' : 'focus', true);
    startTimer(state.totalMs);
  }
  /** Shift the current run by ±ms (works while running, paused or idle). */
  function adjust(ms) {
    if (state.setMode) return;
    if (state.status === 'running') {
      state.deadline = Math.max(Date.now() + 1000, state.deadline + ms);
      state.totalMs = clamp(state.totalMs + ms, 1000, 12 * 60 * MIN);
      if (state.totalMs < (Date.now() - state.startAt) + 1000) state.totalMs = (Date.now() - state.startAt) + 1000;
      schedSig = '';
      play('ui');
    } else if (state.status === 'paused') {
      state.pausedRemaining = clamp(state.pausedRemaining + ms, 1000, 12 * 60 * MIN);
      state.totalMs = clamp(Math.max(state.totalMs, state.pausedRemaining), 1000, 12 * 60 * MIN);
      play('ui');
    } else {
      state.totalMs = clamp(state.totalMs + ms, 1000, 12 * 60 * MIN);
      play('ui');
    }
    render();
    persist();
  }

  /* ------------------------------------------------------- SET (draft time) */
  function openSet() {
    if (state.setMode) { confirmSet(); return; }
    state.setMode = true;
    state.editField = 'min';
    const base = state.status === 'running' ? Math.max(0, state.deadline - Date.now())
      : state.status === 'paused' ? state.pausedRemaining
        : state.totalMs;
    const secs = Math.round(base / 1000);
    state.draft = { min: Math.floor(secs / 60), sec: secs % 60 };
    play('set');
    render();
  }
  function nudgeDraft(field, delta) {
    if (!state.setMode) return;
    state.editField = field;
    if (field === 'min') state.draft.min = clamp(state.draft.min + delta, 0, 720);
    else {
      let s = state.draft.sec + delta;
      let m = state.draft.min;
      if (s >= 60) { s -= 60; m = clamp(m + 1, 0, 720); }
      if (s < 0) {
        if (m > 0) { s += 60; m -= 1; }   /* borrow a minute … */
        else { s = 0; }                    /* … but never wrap below zero */
      }
      state.draft.sec = s; state.draft.min = m;
    }
    play('ui');
    render();
  }
  function confirmSet() {
    if (!state.setMode) return;
    const ms = clamp((state.draft.min * 60 + state.draft.sec) * 1000, 1000, 12 * 60 * MIN);
    state.setMode = false;
    play('set');
    if (state.status === 'running') {
      const elapsed = Date.now() - state.startAt;
      state.totalMs = clamp(elapsed + ms, 1000, 12 * 60 * MIN);
      state.deadline = Date.now() + ms;
      schedSig = '';
    } else if (state.status === 'paused') {
      state.pausedRemaining = ms;
      state.totalMs = clamp(Math.max(state.totalMs, ms), 1000, 12 * 60 * MIN);
    } else {
      state.status = 'idle';
      state.totalMs = ms;
      if (settings.rememberLast && state.phase === 'focus') {
        const minutes = ms / MIN;
        if (Number.isInteger(minutes)) settings.focusMin = minutes;
      }
      saveSettings();
    }
    render();
    persist();
    if (settings.toast) toast({ title: 'Timer set', msg: `${clock(ms)} is on the cube${state.status === 'idle' ? ' — press Start' : ''}.`, kind: 'info', timeout: 3500 });
  }
  function cancelSet() {
    if (!state.setMode) return;
    state.setMode = false;
    play('cancel');
    render();
  }

  /* ------------------------------------------------------------- rendering */
  const screenEl = () => $('#screen');
  function displayMs(now) {
    if (state.setMode) return (state.draft.min * 60 + state.draft.sec) * 1000;
    if (state.status === 'running') return Math.max(0, state.deadline - now);
    if (state.status === 'paused') return Math.max(0, state.pausedRemaining);
    if (state.status === 'finished') return 0;
    return state.totalMs;
  }
  function remainingFraction(now) {
    const total = Math.max(1, state.totalMs);
    if (state.setMode || state.status === 'idle') return 1;
    if (state.status === 'finished') return 0;
    if (state.status === 'paused') return clamp(state.pausedRemaining / total, 0, 1);
    return clamp((state.deadline - now) / total, 0, 1);
  }
  let lastLit = -1;
  function render(now) {
    now = now || Date.now();
    const ms = displayMs(now);
    const frac = remainingFraction(now);
    const scr = screenEl();

    setDigits(clock(ms));
    ui.colon.classList.toggle('on', state.status !== 'finished');

    const lit = Math.ceil(frac * 60);
    if (lit !== lastLit) {
      lastLit = lit;
      for (let i = 0; i < 60; i++) ui.ticks[i].classList.toggle('on', i < lit);
    }
    ui.arc.setAttribute('stroke-dashoffset', String(100 - frac * 100));

    const low = frac <= 0.1 && frac > 0 && !state.setMode;
    scr.classList.toggle('low', low);
    scr.classList.toggle('paused', state.status === 'paused');
    scr.classList.toggle('done', state.status === 'finished');
    scr.classList.toggle('setting', state.setMode);
    scr.classList.toggle('min-mode', state.setMode && state.editField === 'min');
    scr.classList.toggle('sec-mode', state.setMode && state.editField === 'sec');

    /* top + right face prints */
    $('#topNum').textContent = String(Math.round(state.totalMs / MIN));
    $('#sidePhase').textContent = (state.setMode ? 'SET' : state.status === 'finished' ? 'DONE' : PHASES[state.phase].label).toUpperCase();

    /* text readouts */
    const chip = $('#phaseChip');
    chip.textContent = state.setMode ? 'Setting' : PHASES[state.phase].label;
    chip.dataset.phase = state.phase;

    $('#remainingText').textContent = state.setMode
      ? `${clock(ms)} draft`
      : state.status === 'finished' ? '00:00 — done'
        : state.status === 'idle' ? `${clock(ms)} ready`
          : `${clock(ms)} remaining`;

    const elapsed = state.status === 'running' ? clamp((now - state.startAt) / Math.max(1, state.totalMs), 0, 1)
      : state.status === 'paused' ? clamp(1 - state.pausedRemaining / Math.max(1, state.totalMs), 0, 1)
        : state.status === 'finished' ? 1 : 0;
    $('#pctText').textContent = pct(elapsed) + ' elapsed';

    const nx = nextEventLabel(now);
    $('#nextAlert').textContent = state.setMode ? 'Press SET to confirm · Esc to cancel'
      : state.status === 'running' ? (nx ? `Next: ${nx}` : 'No alerts armed')
        : state.status === 'paused' ? 'Paused' : 'Ready';

    /* buttons */
    const startBtn = $('#startBtn');
    startBtn.textContent = state.setMode ? 'SET (confirm)'
      : state.status === 'running' ? 'Pause'
        : state.status === 'paused' ? 'Resume'
          : state.status === 'finished' ? 'Start again' : 'Start';
    startBtn.classList.toggle('is-running', state.status === 'running');
    $('#setBtn').classList.toggle('is-active', state.setMode);
    $('#resetBtn').disabled = state.status === 'idle' && !state.setMode;
    $('#setter').hidden = !state.setMode;
    $('#fieldMin').classList.toggle('is-active', state.editField === 'min');
    $('#fieldSec').classList.toggle('is-active', state.editField === 'sec');
    $('#minInput').value = state.draft.min;
    $('#secInput').value = state.draft.sec;
    $$('.chip', $('#presets')).forEach(ch => {
      const v = Number(ch.dataset.min) * MIN;
      ch.setAttribute('aria-pressed', String(!state.setMode && state.status !== 'running' && Math.abs(v - state.totalMs) < 500));
    });
    ['focus', 'short', 'long'].forEach(p => {
      const b = $('#phase-' + p);
      if (b) b.setAttribute('aria-pressed', String(state.phase === p));
    });
    if (!state.setMode) updateTitle(ms);
    updateDiag();
  }
  function nextEventLabel(now) {
    const list = events().filter(e => !state.fired.has(e.key) && e.target > now);
    if (!list.length) return null;
    const e = list[0];
    const name = e.kind === 'mark'
      ? ({ half: 'halfway alert', p75: '75% alert', p90: '90% alert', finish: 'finish' })[e.id]
      : e.kind === 'call' ? 'time call' : 'final tick';
    return `${name} in ${clock(e.target - now)}`;
  }
  function updateTitle(ms) {
    if (flashTimer) return;            /* the finish flash owns the title for a while */
    const base = 'PomodoroCube';
    if (state.status === 'running') document.title = `${clock(ms)} · ${PHASES[state.phase].label} — ${base}`;
    else if (state.status === 'paused') document.title = `⏸ ${clock(ms)} — ${base}`;
    else if (state.status === 'finished') document.title = `✓ Done — ${base}`;
    else document.title = base;
  }
  let lastDiagAt = 0;
  function updateDiag() {
    const now = Date.now();
    if (now - lastDiagAt < 250) return;
    lastDiagAt = now;
    const d = {
      diagEngine: diag.engine,
      diagTick: diag.tickMs + ' ms',
      diagGap: diag.gapMax ? (diag.gapMax / 1000).toFixed(2) + ' s' : '—',
      diagLate: diag.lateMax ? diag.lateMax + ' ms' : '—',
      diagLateCount: String(diag.lateCount),
      diagJumps: String(diag.jumps),
      diagGaps: String(diag.gaps)
    };
    Object.keys(d).forEach(k => { const el = document.getElementById(k); if (el && el.textContent !== d[k]) el.textContent = d[k]; });
  }
  function live(text) {
    const el = $('#srStatus');
    if (el) el.textContent = text;
  }

  /* ------------------------------------------------------------- notifying */
  function buzz(pattern) {
    if (!settings.vibrate || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (_) {}
  }
  function notify(title, body, quiet) {
    if (!settings.notify) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, {
        body, tag: 'pomodorocube', renotify: !quiet, silent: false,
        icon: 'assets/icon-192.png', badge: 'assets/icon-192.png'
      });
      n.onclick = () => { try { window.focus(); n.close(); } catch (_) {} };
    } catch (_) {}
  }
  function toast(opts) {
    const wrap = $('#toasts');
    if (!wrap) return null;
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.kind = opts.kind || 'alert';
    const t = document.createElement('div');
    t.className = 'toast-title'; t.textContent = opts.title || '';
    const m = document.createElement('div');
    m.className = 'toast-msg'; m.textContent = opts.msg || '';
    el.appendChild(t); el.appendChild(m);
    if (opts.actions && opts.actions.length) {
      const row = document.createElement('div');
      row.className = 'toast-actions';
      opts.actions.forEach(a => {
        const b = document.createElement('button');
        b.className = 'btn btn-sm' + (a.primary ? ' btn-primary' : '');
        b.textContent = a.label;
        b.addEventListener('click', () => { try { a.onClick && a.onClick(); } finally { removeToast(el); } });
        row.appendChild(b);
      });
      el.appendChild(row);
    }
    const close = document.createElement('button');
    close.className = 'btn btn-sm';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '✕';
    close.style.cssText = 'position:absolute;top:8px;right:8px;padding:4px 8px;border-radius:9px';
    close.addEventListener('click', () => removeToast(el));
    el.appendChild(close);
    if (opts.timeout) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.animationDuration = opts.timeout + 'ms';
      el.appendChild(bar);
      const to = setTimeout(() => removeToast(el), opts.timeout);
      el.dataset.timer = String(to);
    }
    wrap.appendChild(el);
    return el;
  }
  function removeToast(el) {
    if (!el || !el.parentNode) return;
    if (el.dataset.timer) clearTimeout(Number(el.dataset.timer));
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 240);
  }
  function dismissToasts() { $$('.toast', $('#toasts')).forEach(removeToast); }

  /* ------------------------------------------------------------ wake lock */
  let wakeLock = null;
  async function requestWake() {
    if (!settings.keepAwake) return;
    try {
      if (!navigator.wakeLock || !navigator.wakeLock.request) return;
      wakeLock = await navigator.wakeLock.request('screen');
      if (wakeLock && wakeLock.addEventListener) wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) { wakeLock = null; }
  }
  function releaseWake() {
    try { if (wakeLock && wakeLock.release) wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }

  /* ---------------------------------------------------------- persistence */
  function persist() {
    if (!settings.restoreSession) { storage.remove(KEY_SESSION); return; }
    storage.write(KEY_SESSION, {
      status: state.status, phase: state.phase, totalMs: state.totalMs,
      startAt: state.startAt, deadline: state.deadline, pausedRemaining: state.pausedRemaining,
      fired: Array.from(state.fired).slice(-120), savedAt: Date.now()
    });
  }
  function restore() {
    if (!settings.restoreSession) return false;
    const s = storage.read(KEY_SESSION, null);
    if (!s || !s.status) return false;
    const now = Date.now();
    if (s.status === 'running' && s.deadline > now) {
      state.status = 'running';
      state.phase = PHASES[s.phase] ? s.phase : 'focus';
      state.totalMs = clamp(Number(s.totalMs) || phaseDuration(), 1000, 12 * 60 * MIN);
      state.startAt = Number(s.startAt) || now;
      state.deadline = Number(s.deadline);
      state.fired = new Set(Array.isArray(s.fired) ? s.fired : []);
      schedSig = '';
      ticker.start(); requestWake();
      const left = state.deadline - now;
      if (settings.toast) toast({ title: 'Session restored', msg: `${clock(left)} remaining — the timer kept running while you were away.`, kind: 'info', timeout: 7000 });
      return true;
    }
    if (s.status === 'running' && s.deadline <= now) {
      /* finished while the page was closed */
      state.phase = PHASES[s.phase] ? s.phase : 'focus';
      state.totalMs = clamp(Number(s.totalMs) || phaseDuration(), 1000, 12 * 60 * MIN);
      state.status = 'finished';
      state.startAt = Number(s.startAt) || now;
      state.deadline = Number(s.deadline);
      state.fired = new Set(Array.isArray(s.fired) ? s.fired : []);
      const ago = Math.round((now - state.deadline) / 60000);
      if (settings.toast) toast({
        title: 'Timer finished while away',
        msg: `Your ${Math.round(state.totalMs / MIN)} minute ${phaseWord()} ended${ago >= 1 ? ` about ${ago} min ago` : ' moments ago'}.`,
        kind: 'done', timeout: 0
      });
      return true;
    }
    if (s.status === 'paused') {
      state.phase = PHASES[s.phase] ? s.phase : 'focus';
      state.totalMs = clamp(Number(s.totalMs) || phaseDuration(), 1000, 12 * 60 * MIN);
      state.pausedRemaining = clamp(Number(s.pausedRemaining) || state.totalMs, 1000, state.totalMs);
      state.status = 'paused';
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------- settings UI */
  function bindToggle(sel, key, after) {
    const el = $(sel);
    if (!el) return;
    const sync = () => el.setAttribute('aria-pressed', String(!!settings[key]));
    sync();
    el.addEventListener('click', () => {
      settings[key] = !settings[key];
      saveSettings(); sync();
      play(settings[key] ? 'set' : 'cancel');
      if (after) after(settings[key]);
      render();
    });
  }
  function bindRange(sel, key, out, fmt) {
    const el = $(sel), o = out ? $(out) : null;
    if (!el) return;
    el.value = settings[key];
    const sync = () => { if (o) o.textContent = fmt ? fmt(settings[key]) : settings[key]; };
    sync();
    el.addEventListener('input', () => {
      settings[key] = Number(el.value);
      saveSettings(); sync();
    });
    el.addEventListener('change', () => {
      if (key === 'volume' && actx) master.gain.value = clamp(settings.volume, 0, 1) * 0.9;
      if (key === 'voiceRate') speak('This is the reminder voice speed.');
    });
  }
  function bindSelect(sel, key, after) {
    const el = $(sel);
    if (!el) return;
    el.value = String(settings[key]);
    el.addEventListener('change', () => {
      const raw = el.value;
      settings[key] = (raw === 'true' || raw === 'false') ? raw === 'true' : (isNaN(Number(raw)) ? raw : Number(raw));
      saveSettings();
      if (after) after(settings[key]);
      render();
    });
  }
  function bindNumber(sel, key, after) {
    const el = $(sel);
    if (!el) return;
    el.value = settings[key];
    el.addEventListener('change', () => {
      const v = clamp(Number(el.value) || 0, 1, 720);
      el.value = v; settings[key] = v; saveSettings();
      if (state.status === 'idle' && PHASES[state.phase].settingKey === key) resetTimer(true);
      if (after) after(v);
      render();
    });
  }

  function applyTheme() {
    const t = settings.theme === 'auto'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : settings.theme;
    document.documentElement.setAttribute('data-theme', t);
    const btn = $('#themeBtn');
    if (btn) btn.textContent = t === 'dark' ? '☀︎ Light' : '☾ Dark';
  }

  /* -------------------------------------------------------------- wiring */
  function wire() {
    $('#startBtn').addEventListener('click', toggleRun);
    $('#resetBtn').addEventListener('click', () => resetTimer());
    $('#setBtn').addEventListener('click', openSet);
    $('#confirmSet').addEventListener('click', confirmSet);
    $('#cancelSet').addEventListener('click', cancelSet);
    $$('#setter .nudge').forEach(b => b.addEventListener('click', () => nudgeDraft(b.dataset.field, Number(b.dataset.delta))));
    $('#fieldMin').addEventListener('click', e => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') { state.editField = 'min'; render(); } });
    $('#fieldSec').addEventListener('click', e => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') { state.editField = 'sec'; render(); } });
    $('#minInput').addEventListener('change', e => { state.draft.min = clamp(Number(e.target.value) || 0, 0, 720); state.editField = 'min'; render(); });
    $('#secInput').addEventListener('change', e => { state.draft.sec = clamp(Number(e.target.value) || 0, 0, 59); state.editField = 'sec'; render(); });
    $$('.chip', $('#presets')).forEach(ch => ch.addEventListener('click', () => {
      if (state.setMode) cancelSet();
      resetTimer(true);                       /* stop any run cleanly first */
      state.totalMs = Number(ch.dataset.min) * MIN;
      if (settings.rememberLast) { settings.focusMin = Number(ch.dataset.min); saveSettings(); }
      play('ui'); render(); persist();
    }));
    ['focus', 'short', 'long'].forEach(p => {
      const b = $('#phase-' + p);
      if (b) b.addEventListener('click', () => setPhase(p));
    });
    $$('.quick').forEach(b => b.addEventListener('click', () => adjust(Number(b.dataset.delta) * MIN)));
    $('#testAlerts').addEventListener('click', testAlerts);
    $('#skip').addEventListener('click', () => { startNextPhase(); });
    $('#cube').addEventListener('click', toggleRun);
    $('#themeBtn').addEventListener('click', () => {
      settings.theme = (document.documentElement.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
      saveSettings(); applyTheme();
    });
    $('#notifyToggle').addEventListener('click', async () => {
      settings.notify = !settings.notify;
      saveSettings();
      $('#notifyToggle').setAttribute('aria-pressed', String(settings.notify));
      if (settings.notify) {
        let granted = false;
        try {
          if (typeof Notification === 'undefined') throw new Error('unsupported');
          granted = (Notification.permission === 'granted') ||
            (await Notification.requestPermission()) === 'granted';
        } catch (_) { granted = false; }
        if (!granted) {
          settings.notify = false; saveSettings();
          $('#notifyToggle').setAttribute('aria-pressed', 'false');
          toast({ title: 'Desktop notifications unavailable', msg: 'Your browser blocked them here (or the page is sandboxed). On-screen reminder cards and voice alerts still work — the deployed GitHub Pages version can request permission normally.', kind: 'info', timeout: 9000 });
        } else {
          play('set');
        }
      } else play('cancel');
    });

    bindToggle('#tHalf', 'alertHalf');
    bindToggle('#t75', 'alert75');
    bindToggle('#t90', 'alert90');
    bindToggle('#tSound', 'sound');
    bindToggle('#tVoice', 'voice');
    bindToggle('#tTicks', 'tickFinal');
    bindToggle('#tToast', 'toast');
    bindToggle('#tVibrate', 'vibrate');
    bindToggle('#tReturn', 'announceOnReturn');
    bindToggle('#tWake', 'keepAwake');
    bindToggle('#tRestore', 'restoreSession');
    bindToggle('#tRemember', 'rememberLast');
    bindToggle('#tRepeatFinish', 'repeatFinish', (on) => { if (!on) stopRepeatChime(); });
    bindToggle('#tAutoBreak', 'autoStartBreak');

    const voiceSel = $('#voiceSel');
    if (voiceSel) {
      loadVoices();
      voiceSel.addEventListener('change', () => {
        settings.voiceURI = voiceSel.value;
        saveSettings();
        play('ui');
        speak('Voice selected. Halfway there. Fifteen minutes remaining.', true);
      });
      if ('speechSynthesis' in window && typeof window.speechSynthesis.addEventListener === 'function') {
        window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
      }
    }
    bindSelect('#announceEvery', 'announceEvery');
    bindSelect('#themeSel', 'theme', applyTheme);
    bindRange('#volume', 'volume', '#volumeOut', v => Math.round(v * 100) + '%');
    bindRange('#voiceRate', 'voiceRate', '#voiceRateOut', v => Number(v).toFixed(2) + '×');
    bindNumber('#focusMin', 'focusMin', () => { if (state.status === 'idle' && state.phase === 'focus') resetTimer(true); });
    bindNumber('#shortMin', 'shortMin');
    bindNumber('#longMin', 'longMin');

    /* keyboard */
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        if (e.key === 'Enter') { e.target.blur(); }
        return;
      }
      const k = e.key;
      if (k === ' ' || k === 'Spacebar') { e.preventDefault(); toggleRun(); }
      else if (k === 'r' || k === 'R') { e.preventDefault(); resetTimer(); }
      else if (k === 's' || k === 'S') { e.preventDefault(); openSet(); }
      else if (k === 'Escape') { if (state.setMode) { e.preventDefault(); cancelSet(); } else dismissToasts(); }
      else if (k === 'Enter') { if (state.setMode) { e.preventDefault(); confirmSet(); } }
      else if (k === 'ArrowUp') { e.preventDefault(); state.setMode ? nudgeDraft(state.editField, 1) : adjust(MIN); }
      else if (k === 'ArrowDown') { e.preventDefault(); state.setMode ? nudgeDraft(state.editField, -1) : adjust(-MIN); }
      else if (k === 'ArrowRight') { e.preventDefault(); state.setMode ? nudgeDraft('sec', 10) : adjust(10000); }
      else if (k === 'ArrowLeft') { e.preventDefault(); state.setMode ? nudgeDraft('sec', -10) : adjust(-10000); }
      else if (k === '1') { setPhase('focus', true); }
      else if (k === '2') { setPhase('short', true); }
      else if (k === '3') { setPhase('long', true); }
      else if (k === 't' || k === 'T') { testAlerts(); }
    });

    /* wake-up / catch-up when the tab becomes visible again */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') { persist(); return; }
      tick();
      if (state.status === 'running') {
        if (settings.keepAwake) requestWake();
        const last = Number(state.lastAnnounce || 0);
        const elapsed = Date.now() - last;
        if (settings.announceOnReturn && elapsed > 90000) {
          state.lastAnnounce = Date.now();
          const left = Math.max(0, state.deadline - Date.now());
          speak(`${human(left)} remaining.`, false);
        }
      }
    });
    window.addEventListener('pagehide', persist);
    window.addEventListener('beforeunload', persist);
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });
    }
    /* iOS/Safari unlock: prime audio + speech on the first real gesture */
    const prime = () => {
      audioContext();
      try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } } catch (_) {}
      document.removeEventListener('pointerdown', prime);
      document.removeEventListener('keydown', prime);
    };
    document.addEventListener('pointerdown', prime);
    document.addEventListener('keydown', prime);

    /* service worker (only on a real https deployment) */
    try {
      const swSecure = location.protocol === 'https:' ||
        ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      if ('serviceWorker' in navigator && swSecure && !window.__PC_NO_SW) {
        window.addEventListener('load', () => {
          navigator.serviceWorker.register('sw.js').catch(() => {});
        });
      }
    } catch (_) {}
  }

  function testAlerts() {
    audioContext();
    const seq = ['half', 'p75', 'p90', 'finish'];
    seq.forEach((n, i) => setTimeout(() => play(n), i * 1000));
    setTimeout(() => speak('This is a PomodoroCube reminder. Fifteen minutes remaining.', true), 3800);
    toast({
      title: 'Alert test',
      msg: 'Playing the 50%, 75%, 90% and finish chimes, then a spoken sample. If you hear nothing, raise the volume or tap Start first (browsers block audio before a click).',
      kind: 'info', timeout: 9000
    });
  }

  /* ---------------------------------------------------------------- init */
  function init() {
    buildDisplay();
    applyTheme();
    wire();
    if (!storage.live) {
      const hint = $('#storageHint');
      if (hint) hint.hidden = false;
    }
    const restored = restore();
    if (!restored) {
      state.totalMs = phaseDuration();
      resetTimer(true);
    }
    render();
    tick();
    setInterval(() => { if (state.status === 'running') render(); }, 500); /* safety net if every tick source is throttled */
    live('PomodoroCube ready. Default timer: 30 minutes.');
    /* built-in accuracy test: add ?test=1 to the URL (see tests/accuracy.test.js) */
    if (new URLSearchParams(location.search).has('test')) {
      const t = document.createElement('script');
      t.src = 'tests/accuracy.test.js';
      t.defer = true;
      document.head.appendChild(t);
    }
    if (!storage.live && settings.toast) {
      toast({ title: 'Preview mode', msg: 'This sandboxed preview cannot store settings or register a service worker — everything else works. On GitHub Pages it all works normally.', kind: 'info', timeout: 8000 });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* expose a tiny debug handle (handy for tests / console) */
  window.__pomodoroCube = {
    state, settings, diag, hooks,
    tick, render, startTimer, pauseTimer, resumeTimer, resetTimer, setPhase, adjust,
    openSet, nudgeDraft, confirmSet, cancelSet,
    clock, human, events, checkEvents, setDigits
  };
})();
