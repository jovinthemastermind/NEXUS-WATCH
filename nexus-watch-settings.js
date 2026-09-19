/* ═══════════════════════════════════════════════════════════════════
   N.E.X.U.S. WATCH — SETTINGS  v1.0.0
   Central place for all user preferences. Single source of truth.
   Depends on: nexus-watch-core.js
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';
  const W = global.NexusWatch;
  if (!W) { console.error('[Settings] core not loaded'); return; }
  const { Bus, Storage } = W;

  const STORAGE_KEY = 'settings';

  const DEFAULTS = {
    theme: 'dark',
    hapticsEnabled: true,
    autoSleepMs: 30000,
    stepsGoal: 8000,
    clock24h: false,
    userName: '',
    // AI settings mirror what nexus-watch-ai uses
    groqKey: '',
  };

  const Settings = (() => {
    let data = Object.assign({}, DEFAULTS, Storage.get(STORAGE_KEY, {}));

    function save() {
      Storage.set(STORAGE_KEY, data);
      Bus.emit('settings:changed', getAll());
    }

    function get(key) { return data[key]; }
    function getAll() { return Object.assign({}, data); }

    function set(key, value) {
      if (!(key in DEFAULTS)) {
        console.warn('[Settings] unknown key:', key);
        return false;
      }
      if (data[key] === value) return true;
      data[key] = value;
      applySideEffects(key, value);
      save();
      Bus.emit('settings:' + key, value);
      return true;
    }

    function setMany(obj) {
      let changed = false;
      for (const k in obj) {
        if (k in DEFAULTS && data[k] !== obj[k]) {
          data[k] = obj[k];
          applySideEffects(k, obj[k]);
          changed = true;
        }
      }
      if (changed) save();
      return changed;
    }

    function reset() {
      data = Object.assign({}, DEFAULTS);
      save();
      Bus.emit('settings:reset');
    }

    // ─── Apply settings to live modules ────────────────────────
    function applySideEffects(key, value) {
      switch (key) {
        case 'autoSleepMs':
          W.Screen && W.Screen.setAutoSleep(value);
          break;
        case 'clock24h':
          W.Clock && W.Clock.set24h(value);
          break;
        case 'stepsGoal':
          W.Sensors && W.Sensors.Steps && W.Sensors.Steps.setGoal(value);
          break;
        case 'hapticsEnabled':
          if (W.Haptics) {
            if (!value) {
              // save originals and stub out
              if (!W.Haptics._orig) {
                W.Haptics._orig = {};
                ['tap','soft','double','triple','success','error','alert','heartbeat','tick','long']
                  .forEach(m => { W.Haptics._orig[m] = W.Haptics[m]; });
              }
              ['tap','soft','double','triple','success','error','alert','heartbeat','tick','long']
                .forEach(m => { W.Haptics[m] = () => false; });
            } else if (W.Haptics._orig) {
              Object.assign(W.Haptics, W.Haptics._orig);
              delete W.Haptics._orig;
            }
          }
          break;
        case 'groqKey':
          W.AI && W.AI.setApiKey(value);
          break;
      }
    }

    // ─── Apply everything on boot ──────────────────────────────
    function applyAll() {
      Object.keys(data).forEach(k => applySideEffects(k, data[k]));
    }

    // Boot: apply once core is ready, plus after a tick to be safe
    if (W.ready) applyAll();
    else W.Bus.once('watch:ready', applyAll);
    setTimeout(applyAll, 500);

    return {
      get, getAll, set, setMany, reset, applyAll,
      DEFAULTS,
    };
  })();

  W.Settings = Settings;
  console.log('✅ NexusWatch settings loaded');
})(window);
