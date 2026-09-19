/* ═══════════════════════════════════════════════════════════════════
   N.E.X.U.S. WATCH — TIMER / STOPWATCH / ALARM  v1.0.0
   Depends on: nexus-watch-core.js
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';
  const W = global.NexusWatch;
  if (!W) { console.error('[Timer] core not loaded'); return; }
  const { Bus, Storage, Haptics, Util } = W;

  // ═══════════════════════════════════════════════════════════════
  // 1. COUNTDOWN TIMER
  // ═══════════════════════════════════════════════════════════════
  const Timer = (() => {
    let totalMs = 0;
    let remainingMs = 0;
    let endsAt = 0;
    let interval = null;
    let state = 'idle';   // 'idle' | 'running' | 'paused' | 'done'

    function tick() {
      remainingMs = Math.max(0, endsAt - Date.now());
      Bus.emit('timer:tick', { remainingMs, totalMs });
      if (remainingMs <= 0) finish();
    }

    function finish() {
      stopInterval();
      state = 'done';
      remainingMs = 0;
      Haptics.alert();
      setTimeout(() => Haptics.alert(), 800);
      setTimeout(() => Haptics.alert(), 1600);
      Bus.emit('timer:done', { totalMs });
    }

    function stopInterval() {
      if (interval) { clearInterval(interval); interval = null; }
    }

    function start(ms) {
      if (ms !== undefined) totalMs = Math.max(0, ms | 0);
      if (totalMs <= 0) return false;
      if (state === 'paused') {
        endsAt = Date.now() + remainingMs;
      } else {
        remainingMs = totalMs;
        endsAt = Date.now() + totalMs;
      }
      state = 'running';
      stopInterval();
      interval = setInterval(tick, 250);
      Bus.emit('timer:started', { totalMs });
      return true;
    }

    function pause() {
      if (state !== 'running') return false;
      state = 'paused';
      remainingMs = Math.max(0, endsAt - Date.now());
      stopInterval();
      Bus.emit('timer:paused', { remainingMs });
      return true;
    }

    function resume() {
      if (state !== 'paused') return false;
      return start();
    }

    function stop() {
      stopInterval();
      state = 'idle';
      remainingMs = 0;
      Bus.emit('timer:stopped');
    }

    function addMs(ms) {
      if (state === 'running') {
        endsAt += ms;
      } else if (state === 'paused') {
        remainingMs = Math.max(0, remainingMs + ms);
      } else {
        totalMs = Math.max(0, totalMs + ms);
      }
      Bus.emit('timer:tick', { remainingMs: remainingMs || totalMs, totalMs });
    }

    return {
      start, pause, resume, stop, addMs,
      get state() { return state; },
      get remainingMs() { return remainingMs || totalMs; },
      get totalMs() { return totalMs; },
      get progress() { return totalMs > 0 ? 1 - (remainingMs / totalMs) : 0; },
    };
  })();

  // ═══════════════════════════════════════════════════════════════
  // 2. STOPWATCH
  // ═══════════════════════════════════════════════════════════════
  const Stopwatch = (() => {
    let startAt = 0;
    let accumulated = 0;
    let interval = null;
    let state = 'idle';
    let laps = [];

    function tick() {
      const elapsed = accumulated + (Date.now() - startAt);
      Bus.emit('stopwatch:tick', { elapsedMs: elapsed });
    }

    function start() {
      if (state === 'running') return false;
      startAt = Date.now();
      state = 'running';
      interval = setInterval(tick, 100);
      Bus.emit('stopwatch:started');
      return true;
    }

    function pause() {
      if (state !== 'running') return false;
      accumulated += Date.now() - startAt;
      clearInterval(interval);
      interval = null;
      state = 'paused';
      Bus.emit('stopwatch:paused', { elapsedMs: accumulated });
      return true;
    }

    function resume() {
      if (state !== 'paused') return false;
      startAt = Date.now();
      state = 'running';
      interval = setInterval(tick, 100);
      Bus.emit('stopwatch:resumed');
      return true;
    }

    function reset() {
      clearInterval(interval);
      interval = null;
      accumulated = 0;
      state = 'idle';
      laps = [];
      Bus.emit('stopwatch:reset');
    }

    function lap() {
      if (state === 'idle') return null;
      const elapsed = accumulated + (state === 'running' ? Date.now() - startAt : 0);
      const last = laps.length ? laps[laps.length - 1].total : 0;
      const entry = { total: elapsed, delta: elapsed - last, n: laps.length + 1 };
      laps.push(entry);
      Haptics.tap();
      Bus.emit('stopwatch:lap', entry);
      return entry;
    }

    return {
      start, pause, resume, reset, lap,
      get state() { return state; },
      get elapsedMs() { return accumulated + (state === 'running' ? Date.now() - startAt : 0); },
      get laps() { return laps.slice(); },
    };
  })();

  // ═══════════════════════════════════════════════════════════════
  // 3. ALARM
  // ═══════════════════════════════════════════════════════════════
  const Alarm = (() => {
    const STORAGE_KEY = 'timer.alarms';
    let alarms = Storage.get(STORAGE_KEY, []);
    let checkInterval = null;

    function save() { Storage.set(STORAGE_KEY, alarms); }

    function add({ hour, minute, label, days, enabled }) {
      const a = {
        id: Util.shortId(6),
        hour: hour | 0,
        minute: minute | 0,
        label: label || 'Alarm',
        days: Array.isArray(days) ? days : [0,1,2,3,4,5,6],  // 0=Sun ... 6=Sat
        enabled: enabled !== false,
        lastFired: 0,
      };
      alarms.push(a);
      save();
      Bus.emit('alarm:added', a);
      return a;
    }

    function remove(id) {
      const i = alarms.findIndex(a => a.id === id);
      if (i < 0) return false;
      alarms.splice(i, 1);
      save();
      Bus.emit('alarm:removed', id);
      return true;
    }

    function toggle(id, on) {
      const a = alarms.find(x => x.id === id);
      if (!a) return false;
      a.enabled = (on === undefined) ? !a.enabled : !!on;
      save();
      Bus.emit('alarm:updated', a);
      return true;
    }

    function check() {
      const now = new Date();
      const h = now.getHours();
      const m = now.getMinutes();
      const d = now.getDay();
      const nowKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${h}-${m}`;
      for (const a of alarms) {
        if (!a.enabled) continue;
        if (!a.days.includes(d)) continue;
        if (a.hour !== h || a.minute !== m) continue;
        if (a.lastFired === nowKey) continue;
        a.lastFired = nowKey;
        save();
        Haptics.alert();
        setTimeout(() => Haptics.alert(), 900);
        Bus.emit('alarm:fired', a);
      }
    }

    function start() {
      if (checkInterval) return;
      checkInterval = setInterval(check, 15000);
      check();
      Bus.emit('alarm:started');
    }

    function stop() {
      if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
    }

    return {
      add, remove, toggle, start, stop,
      get all() { return alarms.slice(); },
    };
  })();

  W.Timer = Timer;
  W.Stopwatch = Stopwatch;
  W.Alarm = Alarm;
  console.log('✅ NexusWatch timer/stopwatch/alarm loaded');
})(window);
