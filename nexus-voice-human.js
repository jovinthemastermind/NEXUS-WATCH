/* ═══════════════════════════════════════════════════════════════════
   N.E.X.U.S. HUMAN VOICE MODULE
   Drop-in replacement for basic speechSynthesis.
   Automatically picks the most human-sounding available voice.
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  // ─── Voice ranking ─────────────────────────────────────────────
  // Higher score = more human-sounding. Adjust these if you find
  // voices that sound better on your specific device.
  const VOICE_RANKINGS = [
    // Microsoft neural (Edge) — best of the best, free
    { match: /Microsoft Aria Online.*Natural/i,          score: 100 },
    { match: /Microsoft Jenny Online.*Natural/i,         score: 99  },
    { match: /Microsoft Ana Online.*Natural/i,           score: 98  },
    { match: /Microsoft Guy Online.*Natural/i,           score: 97  },
    { match: /Microsoft Davis Online.*Natural/i,         score: 96  },
    { match: /Microsoft Michelle Online.*Natural/i,      score: 95  },
    { match: /Microsoft (Eric|Roger|Steffan) Online.*Natural/i, score: 94 },
    { match: /Microsoft.*Natural/i,                      score: 90  },

    // Apple Siri / Premium — excellent on macOS/iOS
    { match: /Samantha.*(Enhanced|Premium)/i,            score: 95  },
    { match: /Siri.*(Enhanced|Premium)/i,                score: 94  },
    { match: /Ava.*(Enhanced|Premium)/i,                 score: 93  },
    { match: /Allison.*(Enhanced|Premium)/i,             score: 92  },
    { match: /Alex.*(Enhanced|Premium)/i,                score: 91  },
    { match: /Samantha/i,                                score: 80  },
    { match: /Siri/i,                                    score: 79  },

    // Google Cloud / Chrome neural-ish
    { match: /Google (US|UK) English.*(Wavenet|Neural)/i, score: 88 },
    { match: /Google (US|UK) English/i,                  score: 60  },

    // Generic English fallbacks
    { match: /^en[-_]?(US|GB|CA|AU)$/i,                  score: 30  },
    { match: /^en/i,                                     score: 20  },
  ];

  function scoreVoice(v) {
    for (const { match, score } of VOICE_RANKINGS) {
      if (match.test(v.name) || match.test(v.voiceURI)) return score;
    }
    return 0;
  }

  function pickBestVoice() {
    const voices = global.speechSynthesis?.getVoices() || [];
    if (!voices.length) return null;

    // Only consider English voices
    const english = voices.filter(v => /^en/i.test(v.lang));
    if (!english.length) return voices[0];

    // Sort by score, tiebreak by local voice (local = no network delay)
    english.sort((a, b) => {
      const ds = scoreVoice(b) - scoreVoice(a);
      if (ds !== 0) return ds;
      return (b.localService ? 1 : 0) - (a.localService ? 1 : 0);
    });

    return english[0];
  }

  // ─── Text prepping for natural speech ──────────────────────────
  function prepText(raw) {
    let t = String(raw || '');

    // Remove visual JSON blocks entirely
    t = t.replace(/```[ \t]*visual[ \t]*\r?\n[\s\S]*?(?:```|$)/gi, '');
    // Remove other code fences
    t = t.replace(/```[\s\S]*?(?:```|$)/g, '');
    // Remove inline LaTeX delimiters but keep the visible content
    t = t.replace(/\$\$([^$]+)\$\$/g, ' $1 ');
    t = t.replace(/\$([^$]+)\$/g, ' $1 ');
    // Replace common LaTeX commands with readable words
    t = t.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '$1 over $2');
    t = t.replace(/\\sqrt\{([^}]+)\}/g, 'square root of $1');
    t = t.replace(/\\times/g, ' times ');
    t = t.replace(/\\div/g, ' divided by ');
    t = t.replace(/\\pm/g, ' plus or minus ');
    t = t.replace(/\\leq/g, ' less than or equal to ');
    t = t.replace(/\\geq/g, ' greater than or equal to ');
    t = t.replace(/\\neq/g, ' not equal to ');
    t = t.replace(/\\cdot/g, ' times ');
    t = t.replace(/\\[a-zA-Z]+/g, ' ');   // strip any remaining commands
    // Remove markdown emphasis/headers/links
    t = t.replace(/[#*_`~]+/g, '');
    t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Remove emojis
    t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
    // Collapse whitespace
    t = t.replace(/\s+/g, ' ').trim();

    return t;
  }

  // Split into sentences so we can add natural micro-pauses.
  function splitSentences(text) {
    // Split on . ! ? followed by space+capital, keeping the terminator.
    const parts = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [text];
    return parts.map(p => p.trim()).filter(Boolean);
  }

  // ─── Voice engine ──────────────────────────────────────────────
  const NexusVoiceHuman = {
    _voice: null,
    _voiceNameOverride: null,
    _enabled: false,
    _speaking: false,
    _onEndCallback: null,

    // Optional tuning
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    sentencePauseMs: 120,

    init() {
      const chosen = this._voiceNameOverride
        ? this._findVoiceByName(this._voiceNameOverride)
        : pickBestVoice();
      this._voice = chosen;
      if (chosen) {
        console.log('[Voice] Using:', chosen.name, '·', chosen.lang);
      } else {
        console.warn('[Voice] No voices available yet');
      }
      return chosen;
    },

    _findVoiceByName(name) {
      const voices = global.speechSynthesis?.getVoices() || [];
      return voices.find(v => v.name === name || v.voiceURI === name) || null;
    },

    // Public: list every voice with a quality score so you can pick.
    listVoices() {
      const voices = global.speechSynthesis?.getVoices() || [];
      return voices.map(v => ({
        name: v.name,
        lang: v.lang,
        local: v.localService,
        qualityScore: scoreVoice(v),
      })).sort((a, b) => b.qualityScore - a.qualityScore);
    },

    // Public: override with a specific voice name.
    setVoice(name) {
      this._voiceNameOverride = name;
      this._voice = this._findVoiceByName(name) || pickBestVoice();
      return this._voice;
    },

    // Public: preview a specific voice with sample text.
    preview(voiceName, text = 'Hello, this is NEXUS. How can I help you today?') {
      const v = this._findVoiceByName(voiceName);
      if (!v) return false;
      const u = new SpeechSynthesisUtterance(text);
      u.voice = v;
      u.rate = this.rate;
      u.pitch = this.pitch;
      u.volume = this.volume;
      global.speechSynthesis.cancel();
      global.speechSynthesis.speak(u);
      return true;
    },

    // Public: speak with natural pacing.
    async speak(text) {
      if (!global.speechSynthesis) return false;
      const clean = prepText(text);
      if (!clean) return false;

      if (!this._voice) this.init();

      // Cancel anything queued.
      global.speechSynthesis.cancel();
      this._speaking = true;

      const sentences = splitSentences(clean);
      for (let i = 0; i < sentences.length; i++) {
        await this._speakOne(sentences[i]);
        // Micro-pause between sentences so it doesn't sound rushed.
        if (i < sentences.length - 1 && this.sentencePauseMs > 0) {
          await new Promise(r => setTimeout(r, this.sentencePauseMs));
        }
      }

      this._speaking = false;
      if (this._onEndCallback) {
        const cb = this._onEndCallback;
        this._onEndCallback = null;
        cb();
      }
      return true;
    },

    _speakOne(text) {
      return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        if (this._voice) u.voice = this._voice;
        u.rate = this.rate;
        u.pitch = this.pitch;
        u.volume = this.volume;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        global.speechSynthesis.speak(u);
      });
    },

    stop() {
      if (!global.speechSynthesis) return;
      global.speechSynthesis.cancel();
      this._speaking = false;
    },

    onEnd(fn) { this._onEndCallback = fn; },

    get enabled() { return this._enabled; },
    get speaking() { return this._speaking; },
    get currentVoice() { return this._voice; },
  };

  // Voices often load asynchronously. Re-init when they arrive.
  if (global.speechSynthesis) {
    global.speechSynthesis.onvoiceschanged = () => {
      if (!NexusVoiceHuman._voice) NexusVoiceHuman.init();
    };
    // Try immediately too.
    NexusVoiceHuman.init();
  }

  global.NexusVoiceHuman = NexusVoiceHuman;
  console.log('✅ NexusVoiceHuman loaded — best voice:',
    NexusVoiceHuman.currentVoice?.name || '(none yet)');
})(window);
