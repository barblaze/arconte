const Sonidos = (() => {
  'use strict';

  let ctx, masterGain, compressor, ambienteActual, silenciado, inicializado;
  let drones = [], pads = [], lfos = [], windNode = null;
  let seqTimers = [], melodiaTimer = null, percTimer = null;

  const ESCALAS = {
    solis: [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88],
    caos:  [261.63, 277.18, 311.13, 369.99, 392.00, 415.30, 466.16],
    abismo:[130.81, 138.59, 155.56, 184.99, 196.00, 207.65, 233.08],
  };

  const ESCALAS_OCT = {};
  Object.keys(ESCALAS).forEach(k => {
    ESCALAS_OCT[k] = ESCALAS[k].concat(ESCALAS[k].map(f => f * 2));
  });

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
    const filtro = crearFiltro('lowpass', 1800, 0.7);
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.08 + Math.random() * 0.08;
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

  function limpiarTimers() {
    if (melodiaTimer) { clearTimeout(melodiaTimer); melodiaTimer = null; }
    if (percTimer) { clearTimeout(percTimer); percTimer = null; }
    seqTimers.forEach(t => clearTimeout(t));
    seqTimers = [];
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
    limpiarTimers();
  }

  function crearReverbSend(modo) {
    const dur = modo === 'abismo' ? 6 : 3;
    const decay = modo === 'caos' ? 2.5 : 4;
    const rev = crearReverb(dur, decay, 0.04);
    const g = ctx.createGain(); g.gain.value = modo === 'solis' ? 0.45 : modo === 'caos' ? 0.55 : 0.7;
    conectar(rev, g, masterGain);
    return rev;
  }

  function tocarGolpe(freq, vol, dur, dest) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const f = crearFiltro('lowpass', 800, 1);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ahora());
    osc.frequency.exponentialRampToValueAtTime(freq * 0.3, ahora() + dur);
    g.gain.setValueAtTime(0, ahora());
    g.gain.linearRampToValueAtTime(vol, ahora() + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, ahora() + dur);
    conectar(osc, f, g, dest || masterGain);
    osc.start(ahora()); osc.stop(ahora() + dur + 0.1);
    return { osc, g };
  }

  function tocarPercusion(vol, dest, sharp) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const env = Math.pow(1 - i / data.length, sharp ? 0.5 : 3);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = crearFiltro('bandpass', sharp ? 3000 : 800, sharp ? 2 : 1);
    const g = ctx.createGain(); g.gain.value = vol || 0.06;
    conectar(src, f, g, dest || masterGain);
    src.start(ahora());
    return { src };
  }

  function getRandomArp(escala, base, count) {
    const result = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * escala.length);
      const mul = 1 + (base + i) % 3;
      result.push(escala[idx] * mul);
    }
    return result;
  }

  function patronMelodiaSolis(escala, rev) {
    const patrones = [
      [0, 2, 4, 6, 4, 2, 0],
      [0, 3, 5, 7, 5, 3, 0],
      [2, 4, 6, 8, 6, 4, 2],
    ];
    const p = patrones[Math.floor(Math.random() * patrones.length)];
    const base = 1 + Math.floor(Math.random() * 2);
    p.forEach((idx, i) => {
      const delay = i * 220;
      const freq = escala[idx % escala.length] * base;
      seqTimers.push(setTimeout(() => {
        fmNota(freq, freq * 4, 2, 0.35, 0.03, rev);
        if (i % 2 === 0) {
          t(freq * 2, 0.15, 'sine', 0.02, masterGain, { attack: 0.002, release: 0.12 });
        }
      }, delay));
    });
    return p.length * 220 + 300;
  }

  function patronMelodiaCaos(escala, rev) {
    const len = 3 + Math.floor(Math.random() * 4);
    const startIdx = Math.floor(Math.random() * (escala.length - len));
    for (let i = 0; i < len; i++) {
      const delay = i * 150;
      const freq = escala[(startIdx + i) % escala.length] * (Math.random() > 0.5 ? 2 : 1);
      seqTimers.push(setTimeout(() => {
        const vol = 0.04 + Math.random() * 0.04;
        t(freq, 0.3, 'sawtooth', vol, rev, {
          attack: 0.005, release: 0.25, sustain: 0.1,
          filter: crearFiltro('bandpass', 500 + Math.random() * 1500, 3)
        });
        if (Math.random() > 0.6) {
          ruido(0.08, 3000, 0.03, masterGain, { attack: 0.001, q: 5 });
        }
      }, delay));
    }
    return len * 150 + 200;
  }

  function patronMelodiaAbismo(escala, rev) {
    const idx = Math.floor(Math.random() * escala.length);
    const freq = escala[idx];
    seqTimers.push(setTimeout(() => {
      t(freq * 0.25, 3.5, 'sine', 0.03, rev, { attack: 0.8, release: 2.0, sustain: 0.4 });
      t(freq * 0.125, 4, 'sine', 0.025, rev, { attack: 1.0, release: 2.5, sustain: 0.3 });
      ruido(1.5, 100, 0.02, rev, { attack: 0.5 });
    }, 0));
    return 3500;
  }

  function iniciarMelodia(modo, rev) {
    if (!ctx) return;
    const escala = ESCALAS[modo];

    const bpm = modo === 'solis' ? 65 : modo === 'caos' ? 95 : 30;
    const intervalo = modo === 'solis' ? 3000 + Math.random() * 1500
                   : modo === 'caos' ? 1800 + Math.random() * 1200
                   : 5000 + Math.random() * 3000;

    function loop() {
      if (ambienteActual !== modo || !ctx) return;
      limpiarTimers();
      let nextDelay;
      if (modo === 'solis') nextDelay = patronMelodiaSolis(escala, rev);
      else if (modo === 'caos') nextDelay = patronMelodiaCaos(escala, rev);
      else nextDelay = patronMelodiaAbismo(escala, rev);
      melodiaTimer = setTimeout(loop, Math.max(nextDelay, 2000));
    }
    melodiaTimer = setTimeout(loop, 1500);
  }

  function iniciarRitmo(modo) {
    if (!ctx) return;

    const ritmo = modo === 'solis' ? { delay: 800, tipo: 'suave' }
                : modo === 'caos' ? { delay: 500, tipo: 'agresivo' }
                : { delay: 2000, tipo: 'profundo' };

    const escala = ESCALAS[modo];

    function loop() {
      if (ambienteActual !== modo || !ctx) return;
      if (modo === 'solis') {
        tocarGolpe(escala[0] * 0.5, 0.04, 0.3, masterGain);
        setTimeout(() => {
          tocarPercusion(0.03, masterGain, false);
        }, ritmo.delay * 0.5);
      } else if (modo === 'caos') {
        if (Math.random() > 0.3) {
          tocarGolpe(escala[Math.floor(Math.random() * escala.length)] * 0.5, 0.05 + Math.random() * 0.05, 0.2, masterGain);
        }
        if (Math.random() > 0.5) {
          tocarPercusion(0.05 + Math.random() * 0.04, masterGain, true);
        }
      } else {
        tocarGolpe(escala[0] * 0.15, 0.06, 0.8, masterGain);
        if (Math.random() > 0.5) {
          ruido(0.5, 60, 0.02, masterGain, { attack: 0.2 });
        }
      }
      const variacion = modo === 'caos' ? Math.random() * 200 - 100 : 0;
      percTimer = setTimeout(loop, ritmo.delay + variacion);
    }
    percTimer = setTimeout(loop, 2000);
  }

  function iniciarAmbiente(modo) {
    if (!ctx || !ESCALAS[modo]) return;
    const escala = ESCALAS[modo];
    const reverbSend = crearReverbSend(modo);

    const lfoRate = ctx.createOscillator();
    const lfoAmp = ctx.createGain();
    const lfoFreq = modo === 'solis' ? 0.10 : modo === 'caos' ? 0.22 : 0.05;
    lfoRate.frequency.value = lfoFreq;
    lfoAmp.gain.value = modo === 'solis' ? 2 : modo === 'caos' ? 6 : 1.5;
    lfoRate.connect(lfoAmp); lfoRate.start();
    lfos.push(lfoRate);

    const detuneAmt = modo === 'caos' ? 8 : modo === 'abismo' ? 3 : 4;
    const filterFreq = modo === 'solis' ? 800 : modo === 'caos' ? 1200 : 400;

    const d1 = crearDroneOsc(modo === 'solis' ? 65.41 : modo === 'caos' ? 55 : 27.5, 'sawtooth', -detuneAmt, modo === 'solis' ? 0.04 : modo === 'caos' ? 0.06 : 0.05, filterFreq);
    const d2 = crearDroneOsc(modo === 'solis' ? 32.7 : modo === 'caos' ? 27.5 : 13.75, 'sine', 0, modo === 'solis' ? 0.05 : modo === 'caos' ? 0.05 : 0.04, null);
    drones.push(d1, d2);

    if (modo === 'caos') {
      const d3 = crearDroneOsc(110, 'square', detuneAmt * 2, 0.02, filterFreq * 1.5);
      drones.push(d3);
    }
    if (modo === 'abismo') {
      const d3 = crearDroneOsc(6.875, 'sine', 0, 0.03, null);
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
      const pd = crearPadOsc(freq * mul, modo === 'solis' ? 'sine' : 'sawtooth', detuneAmt * 2, modo === 'solis' ? 0.03 : modo === 'caos' ? 0.04 : 0.025, reverbSend);
      pads.push(pd);
      pd.gain.gain.linearRampToValueAtTime(pd.targetGain, ahora() + 2.5 + i * 0.8);
    });

    if (modo === 'abismo') {
      const w = ruido(999, 150, 0.025, masterGain, { q: 0.5 });
      if (w) {
        w.src.loop = true;
        const lfoW = ctx.createOscillator();
        const lfoWg = ctx.createGain();
        lfoW.frequency.value = 0.025;
        lfoWg.gain.value = 80;
        lfoW.connect(lfoWg); lfoWg.connect(w.filter.frequency);
        lfoW.start(); lfos.push(lfoW);
        windNode = w;
      }
    }

    iniciarMelodia(modo, reverbSend);
    iniciarRitmo(modo);
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
