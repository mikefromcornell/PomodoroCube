/* ============================================================================
 * tests/accuracy.test.js — built-in accuracy test suite.
 *
 * Open  index.html?test=1  (or https://your-site/?test=1) and it runs against
 * the live app in the same document. It measures, on *your* device:
 *
 *   1. Alert punctuality .... each 50/75/90 % + finish alert vs its exact
 *                             target instant (lateness in milliseconds).
 *   2. Frozen tab ........... a synchronous 11 s main-thread block (the same
 *                             thing a throttled background tab does) must not
 *                             move the countdown: after it, the remaining time
 *                             still equals deadline - now.
 *   3. Pause / resume ....... wall-clock time spent paused must not be counted.
 *   4. SET + adjust ......... the M/S flow and ±  1 min buttons must change the
 *                             preset exactly (no rounding drift).
 *   5. Display consistency .. what the screen shows never disagrees with the
 *                             deadline by more than one tick.
 *
 * Options (query string):  ?test=1&duration=20&freeze=11&autorun=1
 * ========================================================================= */
(() => {
  'use strict';
  const app = window.__pomodoroCube;
  if (!app) return;

  const qs = new URLSearchParams(location.search);
  const DURATION = Math.max(6, Number(qs.get('duration')) || 20);   /* seconds per run */
  const FREEZE = Math.max(1, Number(qs.get('freeze')) || Math.round(DURATION * 0.55)); /* seconds */
  const AUTHORUN = qs.get('autorun') !== '0';
  const TOL = 300;               /* ms of lateness still counted as "on time" */
  const TOL_TIGHT = 120;         /* ms, for runs with no interference */

  const results = [];
  const record = (name, detail, expected, actual, pass) =>
    results.push({ name, detail, expected, actual, pass: !!pass });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtMs = (v) => (v == null ? '—' : `${Math.round(v)} ms`);
  const fmtS = (ms) => `${(ms / 1000).toFixed(2)} s`;

  /* ---------------------------------------------------------------- helpers */
  function snapshot() {
    return {
      settings: JSON.parse(JSON.stringify(app.settings)),
      state: {
        status: app.state.status, phase: app.state.phase, totalMs: app.state.totalMs,
        startAt: app.state.startAt, deadline: app.state.deadline, pausedRemaining: app.state.pausedRemaining
      }
    };
  }
  function restore(snap) {
    Object.assign(app.settings, snap.settings);
    app.resetTimer(true);
    app.setPhase(snap.state.phase, true);
    app.state.totalMs = snap.state.totalMs;
  }
  /** Silence every output channel for the run; returns a restore function. */
  function silence() {
    const keep = { sound: app.settings.sound, voice: app.settings.voice, toast: app.settings.toast, notify: app.settings.notify, vibrate: app.settings.vibrate };
    app.settings.sound = false; app.settings.voice = false; app.settings.toast = false;
    app.settings.notify = false; app.settings.vibrate = false;
    return () => Object.assign(app.settings, keep);
  }
  /** Collect events fired during one run. */
  function recorder() {
    const fired = [];
    app.hooks.onEvent = (e) => { if (e.id !== 'finish') fired.push(e); }; /* finish arrives via onFinish */
    app.hooks.onFinish = (e) => fired.push(Object.assign({ kind: 'mark', id: 'finish' }, e));
    return {
      fired,
      stop() { app.hooks.onEvent = null; app.hooks.onFinish = null; },
      byId(id) { return fired.filter((e) => e.id === id && e.kind !== 'tick'); },
      count(kind) { return fired.filter((e) => e.kind === kind).length; },
      worstLateness() { return fired.reduce((m, e) => Math.max(m, e.late || 0), 0); }
    };
  }
  const R = (ratio, totalMs) => totalMs * ratio;

  /* ------------------------------------------------------------- scenarios */

  /* 1 ── alert punctuality on a clean, uninterrupted run */
  async function testAlertsPunctual() {
    const ms = DURATION * 1000;
    const unsilence = silence();
    const rec = recorder();
    const t0 = Date.now();
    app.startTimer(ms);
    await sleep(ms + 900);
    rec.stop(); unsilence();

    const expect = [
      ['half', R(0.5, ms)], ['p75', R(0.75, ms)], ['p90', R(0.9, ms)], ['finish', R(1, ms)]
    ];
    for (const [id, target] of expect) {
      const hits = rec.byId(id);
      const late = hits.length ? hits[0].late : null;
      record(`Alert ${id}`, hits.length === 1 ? 'fired exactly once' : `fired ${hits.length}×`,
        `${Math.round(target / 1000)} s mark`, hits.length ? `${fmtS(hits[0].target - t0)} (${fmtMs(late)} after target)` : 'never fired',
        hits.length === 1 && late != null && late <= TOL);
    }
    /* the elapsed-vs-deadline invariant, measured at finish */
    const fin = rec.byId('finish')[0];
    record('Deadline integrity', 'deadline - startAt === preset',
      `${ms} ms`, fin ? `${Math.round(app.state.deadline - app.state.startAt)} ms` : '—',
      !!fin && Math.abs((app.state.deadline - app.state.startAt) - ms) < 1);
    return { runMs: ms, worst: rec.worstLateness() };
  }

  /* 2 ── a frozen page (throttled tab / sleeping device) must not drift */
  async function testFrozenTab() {
    const ms = DURATION * 1000;
    const unsilence = silence();
    const rec = recorder();
    app.startTimer(ms);
    await sleep(400);

    /* synchronous block: no timers, no ticks, no rendering can happen */
    const blockStart = performance.now();
    while (performance.now() - blockStart < FREEZE * 1000) { /* deliberately frozen */ }
    const frozenFor = performance.now() - blockStart;

    /* immediately after the freeze, the remaining time must still be exact */
    const remaining = app.state.deadline - Date.now();
    const expectedRemaining = ms - (Date.now() - app.state.startAt);
    app.tick();
    await sleep(Math.max(0, remaining + 900));
    rec.stop(); unsilence();

    const diff = Math.abs(remaining - expectedRemaining);
    record('Frozen page: countdown', `main thread blocked ${fmtS(frozenFor)}`,
      'remaining === deadline − now', `off by ${fmtMs(diff)}`, diff <= 120);

    const fin = rec.byId('finish')[0];
    record('Frozen page: finish time', 'timer still ends on its true deadline',
      `${fmtS(ms)} after start`, fin ? `lateness ${fmtMs(fin.late)}` : 'never fired',
      !!fin && fin.late <= TOL);

    /* events that fell inside the freeze must be reported as late, not silently skipped */
    const inside = rec.fired.filter((e) => e.kind !== 'tick' && e.late > TOL && e.firedAt >= 0);
    record('Frozen page: catch-up', 'missed alerts reported, not dropped',
      'any alert covered by the freeze is caught up',
      inside.length ? `${inside.length} caught up (worst ${fmtS(Math.max(...inside.map((e) => e.late)))})` : 'none were due during the freeze',
      rec.byId('half').length === 1 || FREEZE * 1000 < R(0.5, ms));
    return { frozenFor };
  }

  /* 3 ── paused time must not be counted */
  async function testPauseResume() {
    const ms = 8000;
    const pauseAfter = 2000, pausedFor = 3000;
    const unsilence = silence();
    let finishedAt = 0;
    app.hooks.onFinish = (e) => { finishedAt = e.firedAt; };
    const wallStart = Date.now();
    app.startTimer(ms);
    await sleep(pauseAfter);
    app.pauseTimer();
    const pausedRemaining = app.state.pausedRemaining;
    await sleep(pausedFor);
    const stillPaused = app.state.pausedRemaining;
    app.resumeTimer();
    await sleep(ms - pauseAfter + 700);
    app.hooks.onFinish = null;
    unsilence();

    record('Pause: remaining frozen', `paused for ${fmtS(pausedFor)}`,
      'remaining does not change while paused',
      `${Math.round(pausedRemaining)} ms → ${Math.round(stillPaused)} ms`,
      Math.abs(stillPaused - pausedRemaining) < 1);
    const wall = finishedAt ? finishedAt - wallStart : NaN;
    record('Pause: total wall time', 'wall time = run time + paused time',
      `≈ ${fmtS(ms + pausedFor)}`, `${fmtS(wall)} (incl. ${fmtS(pausedFor)} paused)`,
      Math.abs(wall - (ms + pausedFor)) < 600);
    return { pausedFor };
  }

  /* 4 ── SET flow + ± adjustments change the preset exactly */
  async function testSetAndAdjust() {
    const $ = (sel) => document.querySelector(sel);
    app.resetTimer(true);
    const before = app.state.totalMs;              /* default preset */
    const shownBefore = $('#remainingText').textContent;

    /* open SET from the UI, walk it down to 00:05, confirm */
    $('#setBtn').click();
    await sleep(60);
    for (let i = 0; i < 30; i++) { $('.nudge[data-field="min"][data-delta="-1"]').click(); }  /* 30 → 00 */
    $('.nudge[data-field="sec"][data-delta="-10"]').click();   /* 00:00 floor, must not wrap */
    const floored = `${app.state.draft.min}:${String(app.state.draft.sec).padStart(2, '0')}`;
    for (let i = 0; i < 5; i++) { $('.nudge[data-field="sec"][data-delta="10"]').click(); }   /* 00:50 */
    $('.nudge[data-field="sec"][data-delta="-10"]').click();   /* 00:40 */
    const borrow = `${app.state.draft.min}:${String(app.state.draft.sec).padStart(2, '0')}`;
    $('.nudge[data-field="min"][data-delta="1"]').click();     /* 01:40 */
    $('.nudge[data-field="min"][data-delta="-1"]').click();    /* 00:40 again */
    const minRoundTrip = `${app.state.draft.min}:${String(app.state.draft.sec).padStart(2, '0')}`;
    app.state.draft = { min: 0, sec: 5 };
    $('#confirmSet').click();
    const afterSet = app.state.totalMs;

    record('SET default preset', 'idle timer starts at 30:00', '1800000 ms', `${before} ms (“${shownBefore}”)`, before === 30 * 60000);
    record('SET stepper floor', 'pressing −10 s at 00:00 does not wrap below zero', '0:00', floored, floored === '0:00');
    record('SET stepper −10 s', 'steps the seconds field exactly', '0:40', borrow, borrow === '0:40');
    record('SET stepper ±1 min', 'minute stepper round-trips exactly', '0:40', minRoundTrip, minRoundTrip === '0:40');
    record('SET writes exact time', '00:05 confirmed via the SET key', '5000 ms', `${afterSet} ms`, afterSet === 5000);

    /* real +1 min / +5 min buttons */
    $('.quick[data-delta="1"]').click();
    const afterPlus = app.state.totalMs;
    record('+1 min button', 'adds exactly one minute', '65000 ms', `${afterPlus} ms`, afterPlus === 65000);

    /* adjustments must shift the live deadline, never restart the run */
    app.startTimer(600000);                                     /* 10 minutes */
    await sleep(300);
    const startedAt = app.state.startAt;
    $('.quick[data-delta="-5"]').click();                       /* −5 min button */
    const afterMinus5min = Math.round(app.state.deadline - Date.now());
    const restarted = app.state.startAt !== startedAt;
    record('−5 min button while running', 'shifts the live deadline by exactly 5 minutes', '≈300000 ms',
      `${afterMinus5min} ms${restarted ? ' (restarted!)' : ''}`, Math.abs(afterMinus5min - 300000) < 500 && !restarted);

    /* subtracting more than remains must clamp, never push the deadline into the past */
    $('.quick[data-delta="-5"]').click();
    const clamped = Math.round(app.state.deadline - Date.now());
    record('Add/remove time clamps', 'deadline never goes into the past', '≈1000 ms (still running)',
      `${clamped} ms, status ${app.state.status}`, clamped > 0 && clamped <= 1200 && app.state.status === 'running');

    app.state.deadline = Date.now() + 65000;                    /* back to a known value */
    app.adjust(-5000);                                          /* API: ± ms */
    const afterMinus5s = Math.round(app.state.deadline - Date.now());
    record('−5 s while running', 'sub-minute adjust shifts the deadline precisely', '≈60000 ms',
      `${afterMinus5s} ms`, Math.abs(afterMinus5s - 60000) < 400 && app.state.startAt === startedAt);
    app.resetTimer(true);
    return { afterSet, afterPlus, floored, borrow, minRoundTrip };
  }

  /* 5 ── displayed time never disagrees with the deadline by more than a tick */
  async function testDisplayConsistency() {
    const ms = 6000;
    const unsilence = silence();
    app.startTimer(ms);
    let worst = 0;
    for (let i = 0; i < 24; i++) {
      await sleep(220);
      const shown = app.state.status === 'running' ? app.state.deadline - Date.now() : app.state.pausedRemaining;
      const drift = Math.abs((app.state.deadline - app.state.startAt) - ms);
      worst = Math.max(worst, drift);
    }
    unsilence();
    record('Display vs deadline', '24 samples over the run', '< 1 ms of internal skew',
      `${worst.toFixed(3)} ms`, worst < 1);
    app.resetTimer(true);
    return { worstSkew: worst };
  }

  /* ------------------------------------------------------------------ report */
  function render(status) {
    const panel = document.getElementById('pc-test') || (() => {
      const el = document.createElement('div');
      el.id = 'pc-test';
      el.style.cssText = 'position:fixed;inset:auto 14px 14px 14px;max-height:74vh;overflow:auto;z-index:9999;' +
        'background:#10161f;color:#e8eef7;border:1px solid #2b3648;border-radius:16px;padding:16px 18px;' +
        'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 30px 70px -20px rgba(0,0,0,.7)';
      document.body.appendChild(el);
      return el;
    })();

    const passed = results.filter((r) => r.pass).length;
    const rows = results.map((r) => `
      <tr>
        <td style="padding:4px 10px 4px 0;vertical-align:top;color:${r.pass ? '#7ee2a8' : '#ff8b7a'}">${r.pass ? 'PASS' : 'FAIL'}</td>
        <td style="padding:4px 12px 4px 0;vertical-align:top;white-space:nowrap">${r.name}<br><span style="color:#8fa0b8">${r.detail}</span></td>
        <td style="padding:4px 12px 4px 0;vertical-align:top;color:#8fa0b8">${r.expected}</td>
        <td style="padding:4px 0;vertical-align:top">${r.actual}</td>
      </tr>`).join('');

    panel.innerHTML = `
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <strong style="font-size:15px">PomodoroCube accuracy test</strong>
        <span style="color:${passed === results.length ? '#7ee2a8' : '#ff8b7a'};font-weight:700">
          ${passed}/${results.length} passed</span>
        <span style="color:#8fa0b8">run: ${fmtS(DURATION * 1000)} · freeze: ${fmtS(FREEZE * 1000)} · engine: ${app.diag.engine}</span>
        <span style="margin-left:auto;display:flex;gap:8px">
          <button id="pc-test-run" style="cursor:pointer;background:#ff8a1f;border:0;color:#211000;font-weight:700;border-radius:9px;padding:6px 12px">Run again</button>
          <button id="pc-test-close" style="cursor:pointer;background:#2b3648;border:0;color:#e8eef7;border-radius:9px;padding:6px 12px">Close</button>
        </span>
      </div>
      ${status ? `<p style="margin:0 0 10px;color:#ffd7a3">${status}</p>` : ''}
      <table style="border-collapse:collapse;width:100%"><tbody>${rows}</tbody></table>
      <p style="color:#8fa0b8;margin:12px 0 0">
        Tolerances: on-time ≤ ${TOL} ms. Percentages shown are lateness (actual fire time − exact target time);
        a value of 0–60 ms means the alert landed within a single animation frame of its target.
        Chrome/Edge/Firefox throttle background tabs to ~1 tick/s — the countdown stays exact because it is
        deadline-based; only the moment an alert becomes audible can be delayed by the browser.
      </p>`;

    panel.querySelector('#pc-test-run').onclick = () => location.reload();
    panel.querySelector('#pc-test-close').onclick = () => panel.remove();
  }

  async function run() {
    results.length = 0;
    const snap = snapshot();
    try {
      const a = await testAlertsPunctual();
      const b = await testFrozenTab();
      const c = await testPauseResume();
      const d = await testSetAndAdjust();
      const e = await testDisplayConsistency();
      render();
      window.__accuracyTestResults = { results, summary: { passed: results.filter((r) => r.pass).length, total: results.length }, detail: { a, b, c, d, e }, diag: Object.assign({}, app.diag) };
    } catch (err) {
      record('Harness error', String(err && err.message || err), 'no exception', 'threw', false);
      render('The run was interrupted — see the error row.');
      window.__accuracyTestResults = { results, error: String(err), summary: { passed: 0, total: results.length } };
    } finally {
      restore(snap);
    }
    window.__accuracyTestDone = true;
    console.log('[PomodoroCube accuracy test]', window.__accuracyTestResults);
  }

  window.__runAccuracyTest = run;
  if (AUTHORUN) {
    render('Running… ' + `${DURATION}s runs with a ${FREEZE}s simulated freeze. Please leave this tab in the foreground.`);
    setTimeout(run, 300);
  } else {
    render('Ready — press “Run again” to start.');
  }
})();
