/* ═══════════════════════════════════════════════════════════════════
   N.E.X.U.S. WATCH — AI QUESTIONS  v1.0.0
   Text-only. Calls Groq directly. No voice.
   Depends on: nexus-watch-core.js
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';
  const W = global.NexusWatch;
  if (!W) { console.error('[AI] core not loaded'); return; }
  const { Bus, Storage, Haptics } = W;

  const SETTINGS_KEY = 'ai.settings';

  const AI = (() => {
    let cfg = Storage.get(SETTINGS_KEY, {
      apiKey: '',
      model: 'openai/gpt-oss-20b',       // Groq's fast small model
      smartModel: 'openai/gpt-oss-120b', // Groq's bigger model
      systemPrompt: 'You are NEXUS, a concise personal assistant on a smartwatch. Answer in 1-3 short sentences unless the user asks for detail. No markdown. No emojis.',
      history: [],       // last N turns
      maxHistory: 6,     // 3 turns
    });

    function save() { Storage.set(SETTINGS_KEY, cfg); }

    function setApiKey(k) {
      cfg.apiKey = String(k || '').trim();
      save();
      Bus.emit('ai:key-set');
    }

    function hasKey() { return !!cfg.apiKey && cfg.apiKey.startsWith('gsk_'); }

    // Simple difficulty heuristic from your old NEXUS
    function pickModel(q) {
      const text = String(q || '');
      if (/^smart:?\s/i.test(text)) return cfg.smartModel;
      if (/^fast:?\s/i.test(text))  return cfg.model;
      if (text.length > 200) return cfg.smartModel;
      if (/\b(analyze|compare|derive|prove|explain why|step[- ]by[- ]step)\b/i.test(text)) return cfg.smartModel;
      return cfg.model;
    }

    function stripPrefix(q) {
      return String(q || '').replace(/^(smart|fast):?\s*/i, '').trim();
    }

    function addToHistory(role, content) {
      cfg.history.push({ role, content, at: Date.now() });
      // trim: 2 * maxHistory entries
      const max = cfg.maxHistory * 2;
      if (cfg.history.length > max) cfg.history = cfg.history.slice(-max);
      save();
    }

    function clearHistory() {
      cfg.history = [];
      save();
      Bus.emit('ai:history-cleared');
    }

    async function ask(question, opts = {}) {
      if (!hasKey()) {
        const err = new Error('No Groq API key. Open Settings and paste one.');
        err.code = 'NO_KEY';
        throw err;
      }
      const text = stripPrefix(question);
      if (!text) return '';

      const model = pickModel(question);
      const messages = [
        { role: 'system', content: cfg.systemPrompt },
        ...cfg.history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: text },
      ];

      Bus.emit('ai:thinking', { question: text, model });
      Haptics.tap();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 20000);

      try {
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cfg.apiKey,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.6,
            max_tokens: opts.maxTokens || 400,
            stream: false,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`Groq ${resp.status}: ${body.slice(0, 120)}`);
        }

        const json = await resp.json();
        const answer = json?.choices?.[0]?.message?.content?.trim() || '(empty response)';

        addToHistory('user', text);
        addToHistory('assistant', answer);

        Haptics.success();
        Bus.emit('ai:answer', { question: text, answer, model });
        return answer;
      } catch (e) {
        clearTimeout(timeout);
        Haptics.error();
        const msg = e.name === 'AbortError' ? 'Request timed out' : (e.message || String(e));
        Bus.emit('ai:error', { error: msg });
        throw new Error(msg);
      }
    }

    function setSystemPrompt(p) {
      cfg.systemPrompt = String(p || '').slice(0, 1000);
      save();
    }

    return {
      ask, hasKey, setApiKey, clearHistory, setSystemPrompt,
      get history() { return cfg.history.slice(); },
      get model() { return cfg.model; },
      get smartModel() { return cfg.smartModel; },
    };
  })();

  W.AI = AI;
  console.log('✅ NexusWatch AI loaded —', AI.hasKey() ? 'key present' : 'no key yet');
})(window);
