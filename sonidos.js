const Sonidos = (() => {
  'use strict';

  let ctx, masterGain, compressor, ambienteActual, silenciado, inicializado;
  let buffers = {};
  let loopNodes = { source: null, gain: null };

  const ESCALAS = {
    solis: [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88],
    caos:  [261.63, 277.18, 311.13, 369.99, 392.00, 415.30, 466.16],
    abismo:[130.81, 138.59, 155.56, 184.99, 196.00, 207.65, 233.08],
  };

  function ahora() { return ctx.currentTime; }

  function conectar(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) {
      if (nodes[i]) nodes[i].connect(nodes[i + 1]);
    }
  }

  function oscilar(freq, tipo, detune) {
    const o = ctx.createOscillator();
    o.type = tipo || 'sine'; o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    return o;
  }

  function crearReverb(duracion, decay, preDelay) {
    preDelay = preDelay || 0;
    const len = ctx.sampleRate * (duracion + preDelay);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = (i - preDelay * ctx.sampleRate) / (duracion * ctx.sampleRate);
        data[i] = t > 0 ? (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * Math.pow(t, 0.3) : 0;
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = buf;
    return conv;
  }

  function crearFiltro(tipo, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = tipo; f.frequency.value = freq; if (q) f.Q.value = q;
    return f;
  }

  function t(freq, dur, tipo, vol, dest, opts) {
    if (!ctx) return;
    opts = opts || {};
    const a = opts.attack || 0.02, r = opts.release || dur * 0.5, sus = opts.sustain || 0.7;
    const osc = oscilar(freq, tipo || 'sine', opts.detune || 0);
    const g = ctx.createGain();
    const t0 = ahora();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol || 0.2, t0 + a);
    g.gain.setValueAtTime((vol || 0.2) * sus, t0 + a + 0.02);
    g.gain.linearRampToValueAtTime(0, t0 + a + 0.02 + r);
    const chain = [osc, g];
    if (opts.filter) chain.push(opts.filter);
    chain.push(dest || masterGain);
    conectar(...chain);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }

  function ruido(dur, cutoff, vol, dest, opts) {
    if (!ctx) return;
    opts = opts || {};
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const filter = crearFiltro('lowpass', cutoff || 800, opts.q || 1);
    const g = ctx.createGain();
    const t0 = ahora();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol || 0.1, t0 + (opts.attack || 0.01));
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    conectar(src, filter, g, dest || masterGain);
    src.start(t0);
  }

  function fmNota(carrierFreq, modFreq, modIndex, dur, vol, dest) {
    if (!ctx) return;
    const car = ctx.createOscillator(); car.type = 'sine'; car.frequency.value = carrierFreq;
    const mod = ctx.createOscillator(); mod.type = 'sine'; mod.frequency.value = modFreq;
    const modGain = ctx.createGain(); modGain.gain.value = modIndex;
    const g = ctx.createGain(); g.gain.value = 0;
    const t0 = ahora();
    g.gain.linearRampToValueAtTime(vol || 0.1, t0 + 0.005);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    conectar(mod, modGain, car.frequency);
    conectar(car, g, dest || masterGain);
    car.start(t0); mod.start(t0);
    car.stop(t0 + dur + 0.1); mod.stop(t0 + dur + 0.1);
  }

  async function cargarLoops() {
    if (buffers.solis) return;
    const urls = { solis:'assets/solis.mp3', caos:'assets/caos.mp3', abismo:'assets/abismo.mp3' };
    try {
      await Promise.all(Object.entries(urls).map(async ([modo, url]) => {
        const resp = await fetch(url);
        if (!resp.ok) return;
        buffers[modo] = await ctx.decodeAudioData(await resp.arrayBuffer());
      }));
      if (ambienteActual && buffers[ambienteActual]) iniciarLoop(ambienteActual, 2);
    } catch (e) { console.warn('[Sonidos] Error cargando loops:', e); }
  }

  function iniciarLoop(modo, fadeTime) {
    detenerLoop(0.01);
    if (!buffers[modo] || !ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = buffers[modo];
    src.loop = true;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0, ahora());
    gn.gain.linearRampToValueAtTime(0.6, ahora() + (fadeTime || 2));
    src.connect(gn); gn.connect(masterGain);
    src.start(0);
    loopNodes = { source: src, gain: gn };
  }

  function detenerLoop(fadeTime) {
    if (!loopNodes.source) return;
    const ft = fadeTime || 2;
    const { source: src, gain: gn } = loopNodes;
    loopNodes = { source: null, gain: null };
    try {
      gn.gain.cancelScheduledValues(ahora());
      gn.gain.setValueAtTime(gn.gain.value, ahora());
      gn.gain.linearRampToValueAtTime(0, ahora() + ft);
    } catch (_) {}
    setTimeout(() => {
      try { src.stop(); } catch(_) {}
      try { src.disconnect(); } catch(_) {}
      try { gn.disconnect(); } catch(_) {}
    }, ft * 1000 + 100);
  }

  function detenerAmbiente(fadeTime) {
    fadeTime = fadeTime || 1.5;
    detenerLoop(fadeTime);
  }

  function iniciarAmbiente(modo) {
    if (!ctx || !buffers[modo]) return;
    iniciarLoop(modo, 2);
  }

  const fx = {
    click() {
      if (!ctx) return;
      ruido(0.03, 4000, 0.05, masterGain);
      t(1200, 0.03, 'sine', 0.03, masterGain, { attack: 0.001, release: 0.025 });
    },

    esferaToggle() {
      if (!ctx) return;
      const esNox = ambienteActual === 'caos';
      if (!esNox) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        ruido(0.3, 600, 0.03, masterGain, { attack: 0.001 });
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(660, ahora());
        osc.frequency.exponentialRampToValueAtTime(55, ahora() + 0.6);
        g.gain.setValueAtTime(0, ahora());
        g.gain.linearRampToValueAtTime(0.06, ahora() + 0.02);
        g.gain.linearRampToValueAtTime(0, ahora() + 0.7);
        const f = crearFiltro('lowpass', 1000, 1);
        conectar(osc, f, g, masterGain);
        osc.start(); osc.stop(ahora() + 0.75);
      } else {
        [261.63, 329.63, 392.00, 523.25].forEach((f, i) => {
          setTimeout(() => {
            t(f, 0.8, 'sine', 0.05, masterGain, { attack: 0.02, release: 0.6, sustain: 0.5 });
            t(f * 0.5, 0.8, 'sine', 0.03, masterGain, { attack: 0.04, release: 0.6, sustain: 0.4 });
          }, i * 70);
        });
        setTimeout(() => ruido(0.15, 3000, 0.02, masterGain), 350);
      }
    },

    obtenerItem() {
      if (!ctx) return;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        setTimeout(() => fmNota(f, f * 4, 3, 0.25, 0.035, masterGain), i * 65);
      });
    },

    combateAtaque() {
      if (!ctx) return;
      ruido(0.08, 4000, 0.1, masterGain, { attack: 0.001 });
      ruido(0.06, 2500, 0.06, masterGain, { attack: 0.002 });
      t(120, 0.12, 'sawtooth', 0.06, masterGain, { attack: 0.001, release: 0.1 });
    },

    combateImpacto() {
      if (!ctx) return;
      ruido(0.12, 700, 0.12, masterGain);
      ruido(0.08, 3000, 0.05, masterGain, { attack: 0.001 });
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(200, ahora());
      osc.frequency.exponentialRampToValueAtTime(30, ahora() + 0.25);
      g.gain.setValueAtTime(0.1, ahora());
      g.gain.linearRampToValueAtTime(0, ahora() + 0.3);
      conectar(osc, g, masterGain);
      osc.start(); osc.stop(ahora() + 0.35);
    },

    combateVictoria() {
      if (!ctx) return;
      const melodia = [523.25, 659.25, 783.99, 1046.5, 880, 1046.5, 1318.5];
      const tiempos = [0, 100, 200, 300, 450, 550, 700];
      const rev = crearReverb(2, 3, 0.02);
      rev.connect(masterGain);
      melodia.forEach((f, i) => {
        setTimeout(() => fmNota(f, f * 3, 2, 0.5, 0.035, rev), tiempos[i]);
      });
    },

    combateDerrota() {
      if (!ctx) return;
      [392, 349.23, 311.13, 261.63, 220, 196].forEach((f, i) => {
        setTimeout(() => {
          t(f, 0.8, 'sawtooth', 0.05, masterGain, { attack: 0.01, release: 0.7, filter: crearFiltro('lowpass', 400 + i * 50, 1) });
        }, i * 200);
      });
      setTimeout(() => ruido(1.2, 120, 0.06, masterGain, { attack: 0.3 }), 1300);
    },

    espejo() {
      if (!ctx) return;
      fmNota(880, 1760, 6, 0.25, 0.04, masterGain);
      ruido(0.04, 5000, 0.025, masterGain, { attack: 0.001 });
    },

    espejoCorrecto() {
      if (!ctx) return;
      const rev = crearReverb(1.5, 3, 0.01);
      rev.connect(masterGain);
      [523.25, 783.99, 1046.5].forEach((f, i) => {
        setTimeout(() => fmNota(f, f * 5, 5, 0.4, 0.035, rev), i * 130);
      });
    },

    espejoError() {
      if (!ctx) return;
      ruido(0.3, 250, 0.08, masterGain);
      t(100, 0.3, 'square', 0.06, masterGain, { attack: 0.001, release: 0.3 });
      setTimeout(() => t(80, 0.4, 'square', 0.05, masterGain, { attack: 0.001, release: 0.35 }), 130);
    },

    transicion() {
      if (!ctx) return;
      ruido(0.6, 250, 0.025, masterGain, { attack: 0.08 });
      const fBase = ESCALAS[ambienteActual || 'solis'][0];
      t(fBase, 1.5, 'sine', 0.025, masterGain, { attack: 0.2, release: 1.0 });
    },

    guardado() {
      if (!ctx) return;
      fmNota(880, 1760, 4, 0.2, 0.035, masterGain);
      setTimeout(() => fmNota(1108.73, 2217.46, 4, 0.25, 0.04, masterGain), 110);
    },

    purificarAlma() {
      if (!ctx) return;
      const rev = crearReverb(3, 4, 0.05);
      rev.connect(masterGain);
      [261.63, 329.63, 392, 523.25, 659.25].forEach((f, i) => {
        setTimeout(() => {
          t(f, 1.5, 'sine', 0.04, rev, { attack: 0.05, release: 1.2, sustain: 0.6 });
          t(f * 0.5, 1.5, 'sine', 0.025, rev, { attack: 0.1, release: 1.2, sustain: 0.5 });
        }, i * 130);
      });
    },

    absorberAlma() {
      if (!ctx) return;
      const rev = crearReverb(4, 2, 0.03);
      rev.connect(masterGain);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const f = crearFiltro('lowpass', 800, 2);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(600, ahora());
      osc.frequency.exponentialRampToValueAtTime(40, ahora() + 2.0);
      g.gain.setValueAtTime(0, ahora());
      g.gain.linearRampToValueAtTime(0.06, ahora() + 0.05);
      g.gain.linearRampToValueAtTime(0, ahora() + 2.2);
      conectar(osc, f, g, rev, masterGain);
      osc.start(); osc.stop(ahora() + 2.4);
      ruido(2.0, 150, 0.05, rev, { attack: 0.1 });
    },
  };

  function iniciar() {
    if (inicializado) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -20;
      compressor.knee.value = 8;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.6;
      conectar(masterGain, compressor, ctx.destination);
      inicializado = true;
      cargarLoops();
      setAmbiente('solis');
    } catch (e) {
      console.warn('[Sonidos] Web Audio API no disponible:', e);
    }
  }

  function setAmbiente(modo) {
    if (!ctx || ambienteActual === modo) return;
    detenerAmbiente(1.8);
    ambienteActual = modo;
    setTimeout(() => iniciarAmbiente(modo), 600);
  }

  function silenciar() {
    if (!ctx) return;
    silenciado = !silenciado;
    const target = silenciado ? 0 : 0.6;
    masterGain.gain.linearRampToValueAtTime(target, ahora() + 0.3);
    return silenciado;
  }

  function destruir() {
    detenerAmbiente(0.5);
    setTimeout(() => {
      if (compressor) { try { compressor.disconnect(); } catch(_) {} compressor = null; }
      if (ctx) { ctx.close(); ctx = null; inicializado = false; }
    }, 700);
  }

  function _setupAutoInit() {
    const eventos = ['touchstart', 'mousedown', 'keydown'];
    function handler() {
      iniciar();
      eventos.forEach(ev => document.removeEventListener(ev, handler));
    }
    eventos.forEach(ev => document.addEventListener(ev, handler, { once: true }));
  }

  function _integrarConJuego() {
    const toggle = document.getElementById('esfera-toggle');
    if (toggle) {
      const original = window.cambiarEsfera;
      if (typeof original === 'function') {
        window.cambiarEsfera = function (...args) {
          fx.esferaToggle();
          const result = original.apply(this, args);
          setTimeout(() => {
            const esfera = window.estado?.esfera;
            if (esfera === 'caos') setAmbiente('caos');
            else if (esfera === 'solis') setAmbiente('solis');
          }, 200);
          return result;
        };
      }
    }
    const toastEl = document.getElementById('toast');
    if (toastEl) {
      const obs = new MutationObserver(() => {
        if (toastEl.classList.contains('visible')) fx.obtenerItem();
      });
      obs.observe(toastEl, { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { _setupAutoInit(); _integrarConJuego(); });
  } else {
    _setupAutoInit();
    _integrarConJuego();
  }

  return { iniciar, setAmbiente, silenciar, destruir, fx };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Sonidos;
