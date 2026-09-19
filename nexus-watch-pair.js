/* ═══════════════════════════════════════════════════════════════════
   N.E.X.U.S. WATCH — PAIRING / MESSAGING  v1.0.0
   Uses ntfy.sh (free public relay) — no signup, no server.
   Depends on: nexus-watch-core.js
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';
  const W = global.NexusWatch;
  if (!W) { console.error('[Pair] core not loaded'); return; }
  const { Bus, Storage, Haptics, Util } = W;

  const RELAY = 'https://ntfy.sh';

  const Pair = (() => {
    const STORAGE_KEY = 'pair';
    let cfg = Storage.get(STORAGE_KEY, {
      code: null,           // e.g. "XK4P9Z"
      name: null,           // your display name
      partnerName: null,
    });
    let eventSource = null;
    let connected = false;

    function save() { Storage.set(STORAGE_KEY, cfg); }

    function generateCode() {
      return 'NEXUS-' + Util.shortId(6);
    }

    function topicFor(code) {
      return 'nexuswatch-' + code.toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    // ─── Connection ────────────────────────────────────────────
    function connect() {
      if (!cfg.code) return false;
      disconnect();
      const url = `${RELAY}/${topicFor(cfg.code)}/sse`;
      try {
        eventSource = new EventSource(url);
        eventSource.onopen = () => {
          connected = true;
          Bus.emit('pair:connected', { code: cfg.code });
        };
        eventSource.onerror = () => {
          connected = false;
          Bus.emit('pair:disconnected');
        };
        eventSource.onmessage = (evt) => {
          if (!evt.data) return;
          try {
            const payload = JSON.parse(evt.data);
            if (!payload || payload.event !== 'message' || !payload.message) return;
            let body;
            try { body = JSON.parse(payload.message); }
            catch (_) { body = { type: 'text', text: payload.message }; }
            body._from = body.from || 'partner';
            body._at = Date.now();
            Haptics.triple();
            Bus.emit('pair:message', body);
          } catch (_) {}
        };
      } catch (e) {
        console.warn('[Pair] connect failed:', e);
        return false;
      }
      return true;
    }

    function disconnect() {
      if (eventSource) {
        try { eventSource.close(); } catch (_) {}
        eventSource = null;
      }
      connected = false;
    }

    // ─── Send ──────────────────────────────────────────────────
    async function send(type, data = {}) {
      if (!cfg.code) throw new Error('No pairing code — set one first');
      const body = Object.assign({ type, from: cfg.name || 'me' }, data);
      const resp = await fetch(`${RELAY}/${topicFor(cfg.code)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error('Send failed: ' + resp.status);
      Bus.emit('pair:sent', body);
      return true;
    }

    // ─── Convenience senders ───────────────────────────────────
    function poke()      { return send('poke'); }
    function text(msg)   { return send('text', { text: String(msg).slice(0, 200) }); }
    function buzz()      { return send('buzz'); }
    function emoji(e)    { return send('emoji', { emoji: String(e).slice(0, 4) }); }
    function location()  { return send('location'); }

    // ─── Config ────────────────────────────────────────────────
    function createCode(name) {
      cfg.code = generateCode();
      cfg.name = name || cfg.name || 'Me';
      save();
      connect();
      Bus.emit('pair:code-created', { code: cfg.code });
      return cfg.code;
    }

    function joinCode(code, name) {
      cfg.code = String(code).trim().toUpperCase();
      cfg.name = name || cfg.name || 'Me';
      save();
      connect();
      Bus.emit('pair:joined', { code: cfg.code });
      return cfg.code;
    }

    function setPartnerName(n) {
      cfg.partnerName = String(n).slice(0, 20);
      save();
    }

    function leave() {
      disconnect();
      cfg = { code: null, name: cfg.name, partnerName: null };
      save();
      Bus.emit('pair:left');
    }

    return {
      connect, disconnect, send, poke, text, buzz, emoji, location,
      createCode, joinCode, setPartnerName, leave,
      get code() { return cfg.code; },
      get name() { return cfg.name; },
      get partnerName() { return cfg.partnerName; },
      get connected() { return connected; },
    };
  })();

  W.Pair = Pair;
  console.log('✅ NexusWatch pair loaded');
})(window);
