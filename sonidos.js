const Sonidos = (() => {
  'use strict';

  let ctx, masterGain, compressor, ambienteActual, silenciado, inicializado;
  let drones = [], pads = [], lfos = [], pulsosTimer = null, windNode = null;

  const ESCALAS = {
    solis: [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88],
    caos:  [261.63, 277.18, 311.13, 369.99, 392.00, 415.30, 466.16],
    abismo:[130.81, 138.59, 155.56, 184.99, 196.00, 207.65, 233.08],
  };

  const TIMBRES = {
    solis:  { droneFreq: 65.41, droneGain: 0.06, padGain: 0.04, reverbMix: 0.50, lfoRate: 0.10, lfoDepth: 2,  filterFreq: 800  },
    caos:   { droneFreq: 55.00, droneGain: 0.08, padGain: 0.05, reverbMix: 0.60, lfoRate: 0.22, lfoDepth: 6,  filterFreq: 1200 },
    abismo: { droneFreq: 27.50, droneGain: 0.07, padGain: 0.03, reverbMix: 0.75, lfoRate: 0.05, lfoDepth: 1.5, filterFreq: 400  },
  };

  function ahora() { return ctx.currentTime; }

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

  function crearEnvelope(gain, attack, sustain, release, peak) {
    const t = ahora();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + attack);
    gain.gain.linearRampToValueAtTime(peak * (sustain || 0.7), t + attack + 0.05);
    gain.gain.linearRampToValueAtTime(0, t + attack + 0.05 + (release || 0.3));
  }

  function oscilar(freq, tipo, detune) {
    const o = ctx.createOscillator();
    o.type = tipo || 'sine'; o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    return o;
  }

  function conectar(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) {
      if (nodes[i]) nodes[i].connect(nodes[i + 1]);
    }
  }

  function crearDroneOsc(freq, tipo, detune, gainVal, filterFreq) {
    const osc = oscilar(freq, tipo, detune);
    const gain = ctx.createGain(); gain.gain.value = 0;
    const filtro = filterFreq ? crearFiltro('lowpass', filterFreq, 1) : null;
    const chain = [osc, gain];
    if (filtro) chain.push(filtro);
    chain.push(masterGain);
    conectar(...chain);
    osc.start();
    return { osc, gain, filtro, targetGain: gainVal };
  }

  function crearPadOsc(freq, tipo, detune, gainVal, reverbSend) {
    const osc1 = oscilar(freq, tipo, detune ? -detune : 0);
    const osc2 = oscilar(freq, tipo, detune ? detune : 0);
    const gain = ctx.createGain(); gain.gain.value = 0;
    const filtro = crearFiltro('lowpass', 2000, 0.7);
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.08 + Math.random() * 0.1;
    lfoGain.gain.value = 300;
    lfo.connect(lfoGain); lfoGain.connect(filtro.frequency);
    lfo.start();
    lfos.push(lfo);

    conectar(osc1, gain); conectar(osc2, gain);
    conectar(gain, filtro);
    conectar(filtro, masterGain);
    if (reverbSend) conectar(filtro, reverbSend);

    osc1.start(); osc2.start();
    return { osc1, osc2, gain, lfo, targetGain: gainVal };
  }

  function t(freq, dur, tipo, vol, dest, opts) {
    if (!ctx) return;
    opts = opts || {};
    const a = opts.attack || 0.02, r = opts.release || dur * 0.6, sus = opts.sustain || 0.7;
    const osc = oscilar(freq, tipo || 'sine', opts.detune || 0);
    const g = ctx.createGain();
    const t0 = ahora();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol || 0.2, t0 + a);
    g.gain.linearRampToValueAtTime((vol || 0.2) * sus, t0 + a + 0.02);
    g.gain.linearRampToValueAtTime(0, t0 + a + 0.02 + r);
    const chain = [osc, g];
    if (opts.filter) chain.push(opts.filter);
    chain.push(dest || masterGain);
    conectar(...chain);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
    return { osc, g };
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
    return { src, filter, g };
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

  function detenerAmbiente(fadeTime) {
    fadeTime = fadeTime || 1.5;
    const t = fadeTime * 1000 + 200;
    drones.forEach(d => {
      d.gain.gain.linearRampToValueAtTime(0, ahora() + fadeTime);
      setTimeout(() => { try { d.osc.stop(); } catch(_) {} }, t);
    });
    drones = [];
    pads.forEach(p => {
      p.gain.gain.linearRampToValueAtTime(0, ahora() + fadeTime);
      setTimeout(() => { try { p.osc1.stop(); p.osc2.stop(); } catch(_) {} }, t);
    });
    pads = [];
    lfos.forEach(l => { try { l.stop(); } catch(_) {} });
    lfos = [];
    if (windNode) {
      windNode.g.gain.linearRampToValueAtTime(0, ahora() + fadeTime);
      setTimeout(() => { windNode = null; }, t);
    }
    if (pulsosTimer) { clearTimeout(pulsosTimer); pulsosTimer = null; }
  }

  function crearReverbSend(modo) {
    const dur = modo === 'abismo' ? 5 : 3;
    const decay = modo === 'caos' ? 2 : 4;
    const rev = crearReverb(dur, decay, 0.03);
    const g = ctx.createGain(); g.gain.value = TIMBRES[modo].reverbMix;
    conectar(rev, g, masterGain);
    return rev;
  }

  function iniciarAmbiente(modo) {
    if (!ctx || !TIMBRES[modo]) return;
    const t = TIMBRES[modo], escala = ESCALAS[modo];
    const reverbSend = crearReverbSend(modo);

    const lfoRate = ctx.createOscillator();
    const lfoAmp = ctx.createGain();
    lfoRate.frequency.value = t.lfoRate;
    lfoAmp.gain.value = t.lfoDepth;
    lfoRate.connect(lfoAmp); lfoRate.start();
    lfos.push(lfoRate);

    const detuneAmt = modo === 'caos' ? 8 : modo === 'abismo' ? 3 : 4;
    const fFreq = t.filterFreq;

    const d1 = crearDroneOsc(t.droneFreq, 'sawtooth', -detuneAmt, t.droneGain * 0.5, fFreq);
    const d2 = crearDroneOsc(t.droneFreq * 0.5, 'sine', 0, t.droneGain * 0.6, null);
    drones.push(d1, d2);

    if (modo === 'caos') {
      const d3 = crearDroneOsc(t.droneFreq * 2, 'square', detuneAmt * 2, t.droneGain * 0.25, fFreq * 1.5);
      drones.push(d3);
    }
    if (modo === 'abismo') {
      const d3 = crearDroneOsc(t.droneFreq * 0.25, 'sine', 0, t.droneGain * 0.4, null);
      drones.push(d3);
    }

    drones.forEach(d => {
      lfoAmp.connect(d.osc.detune);
      d.gain.gain.linearRampToValueAtTime(d.targetGain, ahora() + 3);
      conectar(d.osc, d.gain);
      if (d.filtro) conectar(d.gain, d.filtro);
      conectar(d.gain, reverbSend);
    });

    const NOTAS_PAD = modo === 'abismo'
      ? [escala[0], escala[2], escala[4]]
      : [escala[0], escala[2], escala[4], escala[6]];

    NOTAS_PAD.forEach((freq, i) => {
      const mul = modo === 'caos' ? 2 : 1;
      const pd = crearPadOsc(freq * mul, modo === 'solis' ? 'sine' : 'sawtooth', detuneAmt * 2, t.padGain, reverbSend);
      pads.push(pd);
      const desfase = 2.5 + i * 0.8;
      pd.gain.gain.linearRampToValueAtTime(t.padGain, ahora() + desfase);
    });

    if (modo === 'abismo') {
      const w = ruido(999, 200, 0.03, masterGain, { q: 0.5 });
      if (w) {
        w.src.loop = true;
        const lfoW = ctx.createOscillator();
        const lfoWg = ctx.createGain();
        lfoW.frequency.value = 0.03;
        lfoWg.gain.value = 100;
        lfoW.connect(lfoWg); lfoWg.connect(w.filter.frequency);
        lfoW.start(); lfos.push(lfoW);
        windNode = w;
      }
    }

    drones.forEach(d => {
      d.gain.gain.linearRampToValueAtTime(d.targetGain, ahora() + 3);
    });

    programarPulsoAmbiente(modo, reverbSend);
  }

  function programarPulsoAmbiente(modo, reverbSend) {
    if (!ctx) return;
    function pulso() {
      if (ambienteActual !== modo || !ctx) return;
      const escala = ESCALAS[modo];
      const freq = escala[Math.floor(Math.random() * escala.length)];
      const delay = modo === 'solis' ? 8 + Math.random() * 10
                  : modo === 'caos' ? 4 + Math.random() * 6
                  : 12 + Math.random() * 15;

      if (modo === 'solis') {
        fmNota(freq * 2, freq * 6, 4, 2.5, 0.03, reverbSend);
      } else if (modo === 'caos') {
        const perc = ruido(0.3, 1500, 0.04, reverbSend, { q: 3 });
        if (perc) { perc.filter.type = 'bandpass'; perc.filter.Q.value = 5; }
        t(freq * 2, 1.2, 'sawtooth', 0.03, reverbSend, { filter: crearFiltro('lowpass', 600, 1), sustain: 0.2, release: 1.0 });
      } else {
        ruido(1.0, 80, 0.04, reverbSend);
        t(freq * 0.25, 2.0, 'sine', 0.03, reverbSend, { attack: 0.3, release: 1.5, sustain: 0.3 });
      }

      pulsosTimer = setTimeout(pulso, delay * 1000);
    }
    pulsosTimer = setTimeout(pulso, 3000);
  }

  const fx = {
    click() {
      if (!ctx) return;
      ruido(0.04, 4000, 0.06, masterGain);
      t(1200, 0.04, 'sine', 0.04, masterGain, { attack: 0.001, release: 0.03 });
    },

    esferaToggle() {
      if (!ctx) return;
      const esNox = ambienteActual === 'caos';
      if (!esNox) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const noise = ruido(0.3, 800, 0.04, masterGain, { attack: 0.001 });
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(660, ahora());
        osc.frequency.exponentialRampToValueAtTime(55, ahora() + 0.6);
        g.gain.setValueAtTime(0, ahora());
        g.gain.linearRampToValueAtTime(0.08, ahora() + 0.02);
        g.gain.linearRampToValueAtTime(0, ahora() + 0.7);
        const f = crearFiltro('lowpass', 1200, 1);
        conectar(osc, f, g, masterGain);
        osc.start(); osc.stop(ahora() + 0.75);
      } else {
        const notas = [261.63, 329.63, 392.00, 523.25];
        notas.forEach((f, i) => {
          setTimeout(() => {
            t(f, 0.8, 'sine', 0.06, masterGain, { attack: 0.02, release: 0.6, sustain: 0.5 });
          }, i * 60);
        });
        setTimeout(() => ruido(0.2, 3000, 0.03, masterGain), notas.length * 60);
      }
    },

    obtenerItem() {
      if (!ctx) return;
      const notas = [523.25, 659.25, 783.99, 1046.5];
      notas.forEach((f, i) => {
        setTimeout(() => {
          fmNota(f, f * 4, 3, 0.3, 0.04, masterGain);
        }, i * 60);
      });
      setTimeout(() => ruido(0.15, 4000, 0.02, masterGain), 200);
    },

    combateAtaque() {
      if (!ctx) return;
      ruido(0.1, 4000, 0.12, masterGain, { attack: 0.001 });
      ruido(0.08, 2500, 0.08, masterGain, { attack: 0.002 });
      t(120, 0.15, 'sawtooth', 0.08, masterGain, { attack: 0.001, release: 0.12 });
    },

    combateImpacto() {
      if (!ctx) return;
      ruido(0.15, 800, 0.15, masterGain);
      ruido(0.1, 3000, 0.06, masterGain, { attack: 0.001 });
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(200, ahora());
      osc.frequency.exponentialRampToValueAtTime(30, ahora() + 0.25);
      g.gain.setValueAtTime(0.12, ahora());
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
        setTimeout(() => {
          fmNota(f, f * 3, 2, 0.6, 0.04, rev);
        }, tiempos[i]);
      });
    },

    combateDerrota() {
      if (!ctx) return;
      const notas = [392, 349.23, 311.13, 261.63, 220, 196];
      notas.forEach((f, i) => {
        setTimeout(() => {
          t(f, 0.8, 'sawtooth', 0.06, masterGain, { attack: 0.01, release: 0.7, filter: crearFiltro('lowpass', 400 + i * 50, 1) });
        }, i * 180);
      });
      setTimeout(() => ruido(1.0, 150, 0.08, masterGain, { attack: 0.3 }), notas.length * 180);
    },

    espejo() {
      if (!ctx) return;
      fmNota(880, 1760, 6, 0.3, 0.05, masterGain);
      ruido(0.05, 5000, 0.03, masterGain, { attack: 0.001 });
    },

    espejoCorrecto() {
      if (!ctx) return;
      const rev = crearReverb(1.5, 3, 0.01);
      rev.connect(masterGain);
      [523.25, 783.99, 1046.5].forEach((f, i) => {
        setTimeout(() => fmNota(f, f * 5, 5, 0.5, 0.04, rev), i * 120);
      });
    },

    espejoError() {
      if (!ctx) return;
      ruido(0.3, 300, 0.1, masterGain);
      t(100, 0.3, 'square', 0.08, masterGain, { attack: 0.001, release: 0.3 });
      setTimeout(() => t(80, 0.4, 'square', 0.06, masterGain, { attack: 0.001, release: 0.35 }), 120);
    },

    transicion() {
      if (!ctx) return;
      ruido(0.8, 300, 0.03, masterGain, { attack: 0.1 });
      const fBase = ESCALAS[ambienteActual || 'solis'][0];
      t(fBase, 1.5, 'sine', 0.03, masterGain, { attack: 0.2, release: 1.0 });
    },

    guardado() {
      if (!ctx) return;
      fmNota(880, 1760, 4, 0.25, 0.04, masterGain);
      setTimeout(() => fmNota(1108.73, 2217.46, 4, 0.3, 0.05, masterGain), 100);
    },

    purificarAlma() {
      if (!ctx) return;
      const rev = crearReverb(3, 4, 0.05);
      rev.connect(masterGain);
      [261.63, 329.63, 392, 523.25, 659.25].forEach((f, i) => {
        setTimeout(() => {
          t(f, 1.5, 'sine', 0.05, rev, { attack: 0.05, release: 1.2, sustain: 0.6 });
          t(f * 0.5, 1.5, 'sine', 0.03, rev, { attack: 0.1, release: 1.2, sustain: 0.5 });
        }, i * 120);
      });
    },

    absorberAlma() {
      if (!ctx) return;
      const rev = crearReverb(4, 2, 0.03);
      rev.connect(masterGain);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const f = crearFiltro('lowpass', 1000, 2);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(600, ahora());
      osc.frequency.exponentialRampToValueAtTime(40, ahora() + 1.8);
      g.gain.setValueAtTime(0, ahora());
      g.gain.linearRampToValueAtTime(0.08, ahora() + 0.05);
      g.gain.linearRampToValueAtTime(0, ahora() + 2.0);
      conectar(osc, f, g, rev, masterGain);
      osc.start(); osc.stop(ahora() + 2.2);
      ruido(2.0, 200, 0.06, rev, { attack: 0.1 });
    },
  };

  function iniciar() {
    if (inicializado) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 6;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.65;
      conectar(masterGain, compressor, ctx.destination);
      inicializado = true;
      setAmbiente('solis');
    } catch (e) {
      console.warn('[Sonidos] Web Audio API no disponible:', e);
    }
  }

  function setAmbiente(modo) {
    if (!ctx || ambienteActual === modo) return;
    detenerAmbiente(1.8);
    ambienteActual = modo;
    setTimeout(() => iniciarAmbiente(modo), 500);
  }

  function silenciar() {
    if (!ctx) return;
    silenciado = !silenciado;
    const target = silenciado ? 0 : 0.65;
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

    document.addEventListener('click', e => {
      if (e.target.matches('.opcion-btn, .combat-btn')) fx.click();
    });

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
