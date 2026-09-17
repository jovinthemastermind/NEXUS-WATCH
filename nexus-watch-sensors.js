/* ═══════════════════════════════════════════════════════════════════
   N.E.X.U.S. WATCH — SENSORS MODULE
   Depends on: nexus-watch-core.js
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const W = global.NexusWatch;
  if (!W) { console.error('[Sensors] NexusWatch core not loaded'); return; }

  const { Bus, Storage, Haptics, Util } = W;

  // ═══════════════════════════════════════════════════════════════
  // 1. STEP COUNTER — DeviceMotion based
  //
  // Real-world caveat: browser step counting is approximate. It uses
  // the accelerometer and a simple peak-detection algorithm. For a
  // real watch you'd want the OS step API, but this works well enough
  // for a demo and improves with calibration.
  // ═══════════════════════════════════════════════════════════════
  const Steps = (() => {
    const STORAGE_KEY = 'steps';
    let state = {
      today: 0,
      total: 0,
      lastDate: null,
      calibrated: false,
      threshold: 12.5,      // m/s² peak threshold (adjustable)
      minGapMs: 250,        // debounce between steps
      goal: 8000,
    };
    let lastStepTime = 0;
    let lastMagnitude = 0;
    let listening = false;
    let handler = null;

    // ─── Persistence ───────────────────────────────────────
    function load() {
      const saved = Storage.get(STORAGE_KEY, null);
      if (saved) {
        state = Object.assign(state, saved);
      }
      checkDayRollover();
    }

    function save() {
      Storage.set(STORAGE_KEY, state);
    }

    function todayKey() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    function checkDayRollover() {
      const key = todayKey();
      if (state.lastDate !== key) {
        // Store yesterday's total in history
        if (state.lastDate && state.today > 0) {
          const history = Storage.get('steps.history', {});
          history[state.lastDate] = state.today;
          Storage.set('steps.history', history);
        }
        state.lastDate = key;
        state.today = 0;
        save();
      }
    }

    // ─── Detection ─────────────────────────────────────────
    function onMotion(event) {
      const acc = event.accelerationIncludingGravity;
      if (!acc) return;

      // Magnitude of acceleration vector
      const mag = Math.sqrt(
        (acc.x || 0) ** 2 +
        (acc.y || 0) ** 2 +
        (acc.z || 0) ** 2
      );

      const now = Date.now();

      // Peak detection: crossing threshold from below
      const crossedUp = lastMagnitude < state.threshold && mag >= state.threshold;
      const gapOk = (now - lastStepTime) >= state.minGapMs;

      if (crossedUp && gapOk) {
        registerStep(now);
      }

      lastMagnitude = mag;

      // Also emit raw motion for other features (tilt, shake)
      Bus.emit('sensors:motion', { mag, x: acc.x, y: acc.y, z: acc.z });
    }

    function registerStep(now) {
      lastStepTime = now;
      state.today++;
      state.total++;
      save();
      Bus.emit('steps:step', { today: state.today, total: state.total });
      // Check goal
      if (state.today === state.goal) {
        Haptics.success();
        Bus.emit('steps:goal', { goal: state.goal });
      }
    }

    // ─── API ───────────────────────────────────────────────
    async function start() {
      if (listening) return true;

      // iOS 13+ requires an explicit permission request on user gesture
      if (typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function') {
        try {
          const perm = await DeviceMotionEvent.requestPermission();
          if (perm !== 'granted') {
            Bus.emit('steps:permission-denied');
            return false;
          }
        } catch (e) {
          console.warn('[Sensors/Steps] permission request failed:', e);
          return false;
        }
      }

      if (!window.DeviceMotionEvent) {
        Bus.emit('steps:unsupported');
        return false;
      }

      handler = onMotion;
      window.addEventListener('devicemotion', handler, { passive: true });
      listening = true;
      Bus.emit('steps:started');
      return true;
    }

    function stop() {
      if (handler) {
        window.removeEventListener('devicemotion', handler);
        handler = null;
      }
      listening = false;
      Bus.emit('steps:stopped');
    }

    function setGoal(n) {
      state.goal = Math.max(100, n | 0);
      save();
      Bus.emit('steps:goal-changed', { goal: state.goal });
    }

    function setThreshold(v) {
      state.threshold = Math.max(5, Math.min(30, Number(v) || 12.5));
      save();
    }

    function reset() {
      state.today = 0;
      save();
      Bus.emit('steps:reset');
    }

    function get() {
      return {
        today: state.today,
        total: state.total,
        goal: state.goal,
        progress: state.goal > 0 ? Math.min(1, state.today / state.goal) : 0,
      };
    }

    function history(days = 7) {
      const h = Storage.get('steps.history', {});
      const out = [];
      const d = new Date();
      for (let i = 0; i < days; i++) {
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        out.push({ date: key, steps: h[key] || (i === 0 ? state.today : 0) });
        d.setDate(d.getDate() - 1);
      }
      return out.reverse();
    }

    load();
    // Check rollover every 30s in case the app stays open past midnight
    setInterval(checkDayRollover, 30000);

    return {
      start, stop, get, reset, setGoal, setThreshold, history,
      get listening() { return listening; },
    };
  })();

  // ═══════════════════════════════════════════════════════════════
  // 2. MOTION — activity classification (still / walking / running / shake)
  // ═══════════════════════════════════════════════════════════════
  const Motion = (() => {
    const WINDOW_MS = 3000;
    const samples = [];   // { t, mag }
    let currentActivity = 'still';
    let lastEmit = 0;

    function onMotion({ mag }) {
      const now = Date.now();
      samples.push({ t: now, mag });
      // Trim window
      while (samples.length && samples[0].t < now - WINDOW_MS) samples.shift();

      if (now - lastEmit < 500) return;   // emit at most 2x/sec
      lastEmit = now;

      const activity = classify();
      if (activity !== currentActivity) {
        const prev = currentActivity;
        currentActivity = activity;
        Bus.emit('motion:activity', { prev, next: activity });
      }
    }

    function classify() {
      if (samples.length < 5) return 'still';
      let sum = 0, max = 0, min = Infinity;
      for (const s of samples) {
        sum += s.mag;
        if (s.mag > max) max = s.mag;
        if (s.mag < min) min = s.mag;
      }
      const avg = sum / samples.length;
      const variance = max - min;

      // Rough heuristic — tune with your hardware
      if (variance < 2 && Math.abs(avg - 9.8) < 1.5) return 'still';
      if (variance > 25) return 'shake';
      if (variance > 12) return 'running';
      if (variance > 4) return 'walking';
      return 'still';
    }

    function start() {
      Bus.on('sensors:motion', onMotion);
      Bus.emit('motion:started');
    }

    function stop() {
      Bus.off('sensors:motion', onMotion);
      samples.length = 0;
      Bus.emit('motion:stopped');
    }

    return {
      start, stop,
      get activity() { return currentActivity; },
    };
  })();

  // ═══════════════════════════════════════════════════════════════
  // 3. TILT-TO-WAKE — raise wrist → turn screen on
  //
  // Detects the "rotate wrist up to look at watch" motion by watching
  // the accelerometer's y-axis tilt. Fires 'tilt:wake' once per motion.
  // ═══════════════════════════════════════════════════════════════
  const Tilt = (() => {
    let enabled = true;
    let cooldownUntil = 0;
    let lastTilt = 0;
    const COOLDOWN_MS = 2000;
    const TILT_THRESHOLD = 0.55;  // radians-ish (y/z ratio)

    function onMotion({ x, y, z }) {
      if (!enabled || !y || !z) return;
      const now = Date.now();
      if (now < cooldownUntil) return;

      // Ratio of y to z tells us tilt. When watch is raised to face,
      // y becomes dominant.
      const tiltRatio = Math.abs(y) / (Math.abs(z) + 0.001);

      if (tiltRatio > TILT_THRESHOLD && (now - lastTilt) > 800) {
        lastTilt = now;
        cooldownUntil = now + COOLDOWN_MS;
        Bus.emit('tilt:wake');
        Haptics.tap();
      }
    }

    function start() {
      Bus.on('sensors:motion', onMotion);
      Bus.emit('tilt:started');
    }

    function stop() {
      Bus.off('sensors:motion', onMotion);
      Bus.emit('tilt:stopped');
    }

    function enable()  { enabled = true;  Bus.emit('tilt:enabled'); }
    function disable() { enabled = false; Bus.emit('tilt:disabled'); }

    return {
      start, stop, enable, disable,
      get enabled() { return enabled; },
    };
  })();

  // ═══════════════════════════════════════════════════════════════
  // 4. SHAKE — trigger actions by shaking the watch
  // ═══════════════════════════════════════════════════════════════
  const Shake = (() => {
    const COOLDOWN_MS = 1200;
    let lastShake = 0;
    let enabled = true;
    const subscribers = new Set();

    function onActivity({ next }) {
      if (!enabled || next !== 'shake') return;
      const now = Date.now();
      if (now - lastShake < COOLDOWN_MS) return;
      lastShake = now;
      Haptics.double();
      Bus.emit('shake:detected');
      subscribers.forEach(fn => { try { fn(); } catch (_) {} });
    }

    function start() {
      Bus.on('motion:activity', onActivity);
      Bus.emit('shake:started');
    }

    function stop() {
      Bus.off('motion:activity', onActivity);
      Bus.emit('shake:stopped');
    }

    function onShake(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }

    function enable()  { enabled = true; }
    function disable() { enabled = false; }

    return {
      start, stop, onShake, enable, disable,
      get enabled() { return enabled; },
    };
  })();

  // ═══════════════════════════════════════════════════════════════
  // 5. MASTER CONTROL
  // ═══════════════════════════════════════════════════════════════
  const Sensors = {
    Steps, Motion, Tilt, Shake,

    async startAll() {
      const ok = await Steps.start();
      if (ok) {
        Motion.start();
        Tilt.start();
        Shake.start();
      }
      return ok;
    },

    stopAll() {
      Steps.stop();
      Motion.stop();
      Tilt.stop();
      Shake.stop();
    },
  };

  W.Sensors = Sensors;
  console.log('✅ NexusWatch sensors loaded');

})(window);
