/* ═══════════════════════════════════════════════════════════════════
   N.E.X.U.S. WATCH — CORE MODULE
   Foundation for all watch features. No UI. No dependencies.
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  // ─── Namespace ──────────────────────────────────────────────────
  const NexusWatch = {
    version: '0.1.0',
    ready: false,
    _readyResolvers: [],
  };

  // ═══════════════════════════════════════════════════════════════
  // 1. STORAGE — namespaced, JSON-safe, quota-aware
  // ═══════════════════════════════════════════════════════════════
  const STORAGE_PREFIX = 'nexus.watch.';

  const Storage = {
    get(key, fallback = null) {
      try {
        const raw = localStorage.getItem(STORAGE_PREFIX + key);
        if (raw === null) return fallback;
        return JSON.parse(raw);
      } catch (e) {
        console.warn('[Watch/Storage] get failed:', key, e);
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) {
        console.warn('[Watch/Storage] set failed (quota?):', key, e);
        return false;
      }
    },
    remove(key) {
      try { localStorage.removeItem(STORAGE_PREFIX + key); return true; }
      catch (e) { return false; }
    },
    keys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) out.push(k.slice(STORAGE_PREFIX.length));
      }
      return out;
    },
    clearAll() {
      this.keys().forEach(k => this.remove(k));
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // 2. EVENT BUS — pub/sub so features don't hard-depend on each other
  // ═══════════════════════════════════════════════════════════════
  const Bus = (() => {
    const listeners = new Map();
    return {
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
        return () => this.off(event, fn);
      },
      off(event, fn) {
        const set = listeners.get(event);
        if (set) set.delete(fn);
      },
      emit(event, payload) {
        const set = listeners.get(event);
        if (!set) return;
        for (const fn of set) {
          try { fn(payload); }
          catch (e) { console.error('[Watch/Bus] listener error on', event, e); }
        }
      },
      once(event, fn) {
        const unsub = this.on(event, (p) => { unsub(); fn(p); });
        return unsub;
      },
      listenerCount(event) {
        const set = listeners.get(event);
        return set ? set.size : 0;
      },
    };
  })();

  // ═══════════════════════════════════════════════════════════════
  // 3. HAPTICS — vibration patterns
  //    Spec: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate
  // ═══════════════════════════════════════════════════════════════
  const Haptics = {
    supported: typeof navigator !== 'undefined' && 'vibrate' in navigator,

    _fire(pattern) {
      if (!this.supported) return false;
      try { return navigator.vibrate(pattern); }
      catch (e) { return false; }
    },

    // Basic pulses
    tap()      { return this._fire(12); },
    soft()     { return this._fire(8); },
    double()   { return this._fire([10, 60, 10]); },
    triple()   { return this._fire([10, 50, 10, 50, 10]); },
    success()  { return this._fire([15, 40, 30]); },
    error()    { return this._fire([40, 30, 40, 30, 40]); },
    alert()    { return this._fire([100, 50, 100, 50, 200]); },
    heartbeat(){ return this._fire([60, 80, 60, 500, 60, 80, 60]); },
    tick()     { return this._fire(5); },
    long()     { return this._fire(400); },

    stop() {
      if (!this.supported) return false;
      try { return navigator.vibrate(0); }
      catch (e) { return false; }
    },

    // Morse-style pattern for custom notifications
    pattern(pulses) {
      return this._fire(pulses);
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // 4. BATTERY — monitor and warn
  // ═══════════════════════════════════════════════════════════════
  const Battery = {
    _battery: null,
    _lastLevel: null,
    _lastCharging: null,
    supported: typeof navigator !== 'undefined' && 'getBattery' in navigator,

    async init() {
      if (!this.supported) return null;
      try {
        this._battery = await navigator.getBattery();
        this._lastLevel = Math.round(this._battery.level * 100);
        this._lastCharging = this._battery.charging;

        this._battery.addEventListener('levelchange', () => {
          const pct = Math.round(this._battery.level * 100);
          if (pct !== this._lastLevel) {
            const prev = this._lastLevel;
            this._lastLevel = pct;
            Bus.emit('battery:level', { level: pct, charging: this._battery.charging });
            // Warn thresholds
            if (pct <= 10 && prev > 10) Bus.emit('battery:critical', { level: pct });
            else if (pct <= 20 && prev > 20) Bus.emit('battery:low', { level: pct });
          }
        });

        this._battery.addEventListener('chargingchange', () => {
          const charging = this._battery.charging;
          if (charging !== this._lastCharging) {
            this._lastCharging = charging;
            Bus.emit('battery:charging', { charging, level: this._lastLevel });
            if (charging) Haptics.success();
          }
        });

        Bus.emit('battery:ready', this.get());
        return this.get();
      } catch (e) {
        console.warn('[Watch/Battery] init failed:', e);
        return null;
      }
    },

    get() {
      if (!this._battery) return null;
      return {
        level: Math.round(this._battery.level * 100),
        charging: this._battery.charging,
        chargingTime: this._battery.chargingTime,
        dischargingTime: this._battery.dischargingTime,
      };
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // 5. CLOCK — live time, formatted for watch display
  // ═══════════════════════════════════════════════════════════════
  const Clock = (() => {
    let tickTimer = null;
    let lastMinute = -1;

    function format12h(date) {
      let h = date.getHours();
      const m = date.getMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return { h, m, ampm, hh: String(h).padStart(2, '0'), mm: String(m).padStart(2, '0') };
    }

    function format24h(date) {
      return {
        hh: String(date.getHours()).padStart(2, '0'),
        mm: String(date.getMinutes()).padStart(2, '0'),
        ss: String(date.getSeconds()).padStart(2, '0'),
      };
    }

    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    function dateLine(date) {
      return `${DAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`;
    }

    function start() {
      if (tickTimer) return;
      tickTimer = setInterval(() => {
        const now = new Date();
        Bus.emit('clock:second', now);
        if (now.getMinutes() !== lastMinute) {
          lastMinute = now.getMinutes();
          Bus.emit('clock:minute', now);
          // Hourly chime
          if (now.getMinutes() === 0) {
            Bus.emit('clock:hour', now);
            Haptics.double();
          }
        }
      }, 1000);
      Bus.emit('clock:second', new Date());
    }

    function stop() {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    return {
      start, stop,
      now: () => new Date(),
      format12h, format24h, dateLine,
      time12: () => { const t = format12h(new Date()); return `${t.h}:${t.mm} ${t.ampm}`; },
      time24: () => { const t = format24h(new Date()); return `${t.hh}:${t.mm}`; },
      time24sec: () => { const t = format24h(new Date()); return `${t.hh}:${t.mm}:${t.ss}`; },
    };
  })();

  // ═══════════════════════════════════════════════════════════════
  // 6. WAKE LOCK — keep screen on when needed (e.g. during voice)
  // ═══════════════════════════════════════════════════════════════
  const WakeLock = {
    _sentinel: null,
    supported: typeof navigator !== 'undefined' && 'wakeLock' in navigator,

    async request(type = 'screen') {
      if (!this.supported) return false;
      try {
        this._sentinel = await navigator.wakeLock.request(type);
        this._sentinel.addEventListener('release', () => {
          Bus.emit('wakelock:released');
        });
        Bus.emit('wakelock:active');
        return true;
      } catch (e) {
        console.warn('[Watch/WakeLock]', e);
        return false;
      }
    },

    async release() {
      if (this._sentinel) {
        try { await this._sentinel.release(); } catch (_) {}
        this._sentinel = null;
      }
    },

    get active() { return !!this._sentinel && !this._sentinel.released; },
  };

  // ═══════════════════════════════════════════════════════════════
  // 7. SCREEN STATE — on/off/dim, auto-sleep
  // ═══════════════════════════════════════════════════════════════
  const Screen = {
    _state: 'on',                // 'on' | 'dim' | 'off'
    _autoSleepTimer: null,
    _autoSleepMs: 30000,         // default 30s

    setState(next) {
      if (this._state === next) return;
      const prev = this._state;
      this._state = next;
      Bus.emit('screen:state', { prev, next });
      if (next === 'off') Bus.emit('screen:off');
      else if (next === 'on') Bus.emit('screen:on');
      else if (next === 'dim') Bus.emit('screen:dim');
    },

    on()   { this.setState('on'); this._armAutoSleep(); },
    dim()  { this.setState('dim'); },
    off()  { this.setState('off'); },

    // Call on any user interaction to reset the auto-sleep timer
    poke() {
      if (this._state !== 'on') this.setState('on');
      this._armAutoSleep();
    },

    setAutoSleep(ms) {
      this._autoSleepMs = ms;
      this._armAutoSleep();
    },

    _armAutoSleep() {
      if (this._autoSleepTimer) clearTimeout(this._autoSleepTimer);
      if (this._autoSleepMs <= 0) return;
      this._autoSleepTimer = setTimeout(() => {
        Bus.emit('screen:auto-dim');
        this.setState('dim');
        setTimeout(() => {
          if (this._state === 'dim') {
            Bus.emit('screen:auto-off');
            this.setState('off');
          }
        }, 5000);
      }, this._autoSleepMs);
    },

    get state() { return this._state; },
  };

  // ═══════════════════════════════════════════════════════════════
  // 8. UTILITIES
  // ═══════════════════════════════════════════════════════════════
  const Util = {
    // Clamp number to range
    clamp(n, min, max) { return Math.min(max, Math.max(min, n)); },

    // Format a duration (ms) as mm:ss or h:mm:ss
    formatDuration(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    },

    // Format steps with thousands separator
    formatNumber(n) { return Number(n).toLocaleString(); },

    // Debounce
    debounce(fn, ms) {
      let t = null;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
      };
    },

    // Throttle (leading edge)
    throttle(fn, ms) {
      let last = 0;
      return function (...args) {
        const now = Date.now();
        if (now - last >= ms) {
          last = now;
          fn.apply(this, args);
        }
      };
    },

    // Random int
    randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },

    // Sleep
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    // UUID (short, for pairing codes etc.)
    shortId(len = 6) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let out = '';
      for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
      return out;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // 9. LIFECYCLE — init, wake, sleep, visibility
  // ═══════════════════════════════════════════════════════════════
  const Lifecycle = {
    async init() {
      // Battery
      await Battery.init();

      // Clock
      Clock.start();

      // Auto-sleep timer
      Screen._armAutoSleep();

      // Wake on any user interaction
      const poke = () => Screen.poke();
      ['touchstart', 'mousedown', 'keydown', 'click'].forEach(evt => {
        document.addEventListener(evt, poke, { passive: true });
      });

      // Page visibility
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          Bus.emit('app:hidden');
          WakeLock.release();
        } else {
          Bus.emit('app:visible');
        }
      });

      // Before unload — persist anything you want
      window.addEventListener('beforeunload', () => {
        Bus.emit('app:unloading');
      });

      this._ready();
    },

    _ready() {
      NexusWatch.ready = true;
      Bus.emit('watch:ready');
      NexusWatch._readyResolvers.forEach(r => r());
      NexusWatch._readyResolvers = [];
    },

    whenReady() {
      if (NexusWatch.ready) return Promise.resolve();
      return new Promise(r => NexusWatch._readyResolvers.push(r));
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // 10. PUBLIC API
  // ═══════════════════════════════════════════════════════════════
  NexusWatch.Storage = Storage;
  NexusWatch.Bus = Bus;
  NexusWatch.Haptics = Haptics;
  NexusWatch.Battery = Battery;
  NexusWatch.Clock = Clock;
  NexusWatch.WakeLock = WakeLock;
  NexusWatch.Screen = Screen;
  NexusWatch.Util = Util;
  NexusWatch.Lifecycle = Lifecycle;

  // Auto-boot when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Lifecycle.init());
  } else {
    Lifecycle.init();
  }

  global.NexusWatch = NexusWatch;
  console.log('✅ NexusWatch core v' + NexusWatch.version + ' loaded');

})(window);
