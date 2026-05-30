/**
 * ═══════════════════════════════════════════════════════
 *  ARCONTE DEL ALBA — Sistema de Sonido
 *  sonidos.js
 *
 *  Motor de audio 100% procedural usando Web Audio API.
 *  Sin archivos externos. Genera música y efectos en tiempo
 *  real acorde al estado del juego (Solis / Nox / Abismo).
 *
 *  Uso:
 *    Sonidos.iniciar();                 // tras un gesto del usuario
 *    Sonidos.setAmbiente('solis');      // cambia la atmósfera
 *    Sonidos.setAmbiente('caos');
 *    Sonidos.setAmbiente('abismo');
 *    Sonidos.fx.click();               // UI tap
 *    Sonidos.fx.esferaToggle();        // toggle Solis↔Nox
 *    Sonidos.fx.obtenerItem();
 *    Sonidos.fx.combateAtaque();
 *    Sonidos.fx.combateImpacto();
 *    Sonidos.fx.combateVictoria();
 *    Sonidos.fx.combateDerrota();
 *    Sonidos.fx.espejo();              // puzzle espejos
 *    Sonidos.fx.espejoCorrecto();
 *    Sonidos.fx.espejoError();
 *    Sonidos.fx.transicion();          // fade entre nodos
 *    Sonidos.fx.guardado();
 *    Sonidos.fx.purificarAlma();
 *    Sonidos.fx.absorberAlma();
 *    Sonidos.silenciar();              // mute/unmute toggle
 *    Sonidos.destruir();               // liberar recursos
 * ═══════════════════════════════════════════════════════
 */

const Sonidos = (() => {
  'use strict';

  // ── Estado interno ───────────────────────────────────
  let ctx            = null;   // AudioContext
  let masterGain     = null;   // volumen global
  let ambienteActual = null;   // 'solis' | 'caos' | 'abismo'
  let droneNode      = null;   // oscilador de drone activo
  let padNodes       = [];     // nodos del pad armónico
  let lfoNode        = null;   // LFO global de vibrato
  let silenciado     = false;
  let inicializado   = false;

  // ── Escalas modales (frecuencias en Hz, base MIDI aprox.) ──
  const ESCALAS = {
    solis: [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88],  // Do Mayor
    caos:  [261.63, 277.18, 311.13, 369.99, 392.00, 415.30, 466.16],  // Frigio Dominante
    abismo:[130.81, 138.59, 155.56, 184.99, 196.00, 207.65, 233.08],  // Locrio (octava baja)
  };

  // ── Paletas de timbre por modo ──────────────────────
  const TIMBRES = {
    solis:  { wave: 'sine',     droneFreq: 130.81, droneGain: 0.07, padGain: 0.05, reverbMix: 0.45, lfoRate: 0.12, lfoDepth: 3  },
    caos:   { wave: 'sawtooth', droneFreq: 110.00, droneGain: 0.09, padGain: 0.06, reverbMix: 0.55, lfoRate: 0.28, lfoDepth: 8  },
    abismo: { wave: 'square',   droneFreq:  55.00, droneGain: 0.11, padGain: 0.04, reverbMix: 0.70, lfoRate: 0.06, lfoDepth: 2  },
  };

  // ════════════════════════════════════════════════════
  // HELPERS DE AUDIO
  // ════════════════════════════════════════════════════

  /** Crea un reverb sintético con ConvolverNode */
  function crearReverb(duracion = 2.5, decay = 3.0) {
    const len     = ctx.sampleRate * duracion;
    const buffer  = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = buffer;
    return conv;
  }

  /** Rampa suave de ganancia para evitar clicks */
  function rampGain(gainNode, target, tiempo = 0.05) {
    gainNode.gain.linearRampToValueAtTime(target, ctx.currentTime + tiempo);
  }

  /** Nota corta con envelope ADSR simplificado */
  function tocar(frecuencia, duracion, tipo = 'sine', volumen = 0.25, destino = null) {
    if (!ctx) return;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    const dest = destino || masterGain;

    osc.type            = tipo;
    osc.frequency.value = frecuencia;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volumen, ctx.currentTime + 0.02);
    gain.gain.linearRampToValueAtTime(volumen * 0.6, ctx.currentTime + duracion * 0.4);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duracion);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duracion + 0.05);
  }

  /** Ruido blanco filtrado (percusión o viento) */
  function ruido(duracion, frecCorte = 800, volumen = 0.15) {
    if (!ctx) return;
    const buf    = ctx.createBuffer(1, ctx.sampleRate * duracion, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src    = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain   = ctx.createGain();

    src.buffer         = buf;
    filter.type        = 'lowpass';
    filter.frequency.value = frecCorte;
    gain.gain.setValueAtTime(volumen, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duracion);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    src.start();
  }

  // ════════════════════════════════════════════════════
  // MOTOR DE AMBIENTE
  // ════════════════════════════════════════════════════

  function detenerAmbiente(fadeTime = 1.5) {
    if (droneNode) {
      droneNode.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeTime);
      setTimeout(() => { try { droneNode.osc.stop(); } catch (_) {} droneNode = null; }, fadeTime * 1000 + 100);
    }
    padNodes.forEach(p => {
      p.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeTime);
      setTimeout(() => { try { p.osc.stop(); } catch (_) {} }, fadeTime * 1000 + 100);
    });
    padNodes = [];
    if (lfoNode) { try { lfoNode.stop(); } catch (_) {} lfoNode = null; }
  }

  function iniciarAmbiente(modo) {
    if (!ctx || !TIMBRES[modo]) return;
    const t = TIMBRES[modo];
    const escala = ESCALAS[modo];

    // Reverb compartido
    const reverb     = crearReverb(modo === 'abismo' ? 4 : 2.5, modo === 'caos' ? 2 : 3.5);
    const reverbGain = ctx.createGain();
    reverbGain.gain.value = t.reverbMix;
    reverb.connect(reverbGain);
    reverbGain.connect(masterGain);

    // LFO de vibrato
    lfoNode = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfoNode.frequency.value = t.lfoRate;
    lfoGain.gain.value      = t.lfoDepth;
    lfoNode.connect(lfoGain);
    lfoNode.start();

    // Drone fundamental (pedal tone)
    const droneOsc  = ctx.createOscillator();
    const droneGain = ctx.createGain();
    droneOsc.type            = t.wave;
    droneOsc.frequency.value = t.droneFreq;
    lfoGain.connect(droneOsc.detune);                   // vibrato
    droneGain.gain.setValueAtTime(0, ctx.currentTime);
    droneGain.gain.linearRampToValueAtTime(t.droneGain, ctx.currentTime + 2.5);
    droneOsc.connect(droneGain);
    droneGain.connect(masterGain);
    droneGain.connect(reverb);
    droneOsc.start();
    droneNode = { osc: droneOsc, gain: droneGain };

    // Pad armónico — arpegio lento de la escala
    const NOTAS_PAD = modo === 'abismo'
      ? [escala[0], escala[2], escala[4]]
      : [escala[0], escala[2], escala[4], escala[6]];

    NOTAS_PAD.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * (modo === 'caos' ? 2 : 1);
      // Desfase entre voces para efecto coral
      const desfase = i * 0.6;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(t.padGain, ctx.currentTime + 2.5 + desfase);
      osc.connect(gain);
      gain.connect(reverb);
      gain.connect(masterGain);
      osc.start();
      padNodes.push({ osc, gain });
    });

    // Pulso de campana (Solis) / distorsión (Caos) / silencio grave (Abismo)
    programarPulsoAmbiente(modo, reverb);
  }

  /** Pulsos periódicos que refuerzan la atmósfera */
  function programarPulsoAmbiente(modo, reverb) {
    if (!ctx) return;

    function pulso() {
      if (ambienteActual !== modo || !ctx) return;
      const escala = ESCALAS[modo];
      const freq   = escala[Math.floor(Math.random() * escala.length)];
      const delay  = modo === 'solis'  ? 6 + Math.random() * 8
                   : modo === 'caos'   ? 3 + Math.random() * 5
                   :                     9 + Math.random() * 12;

      if (modo === 'solis') {
        // Campana cristalina (sine con ataque breve)
        tocar(freq * 4, 3.5, 'sine', 0.06, reverb);
      } else if (modo === 'caos') {
        // Voz caótica (sawtooth breve con filtro)
        const osc    = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const gain   = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value   = freq * 2;
        filter.type           = 'bandpass';
        filter.frequency.value = 600 + Math.random() * 800;
        filter.Q.value        = 4;
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.8);
        osc.connect(filter); filter.connect(gain); gain.connect(reverb);
        osc.start(); osc.stop(ctx.currentTime + 2);
      } else {
        // Abismo: golpe sub-grave
        ruido(1.2, 120, 0.1);
        tocar(freq * 0.5, 2.5, 'sine', 0.05, reverb);
      }

      setTimeout(pulso, delay * 1000);
    }

    setTimeout(pulso, (modo === 'abismo' ? 4 : 2) * 1000);
  }

  // ════════════════════════════════════════════════════
  // EFECTOS DE SONIDO (FX)
  // ════════════════════════════════════════════════════

  const fx = {

    /** Tap genérico de UI — click de pergamino */
    click() {
      if (!ctx) return;
      tocar(880, 0.06, 'sine', 0.12);
      tocar(660, 0.08, 'sine', 0.06);
    },

    /** Toggle de esfera Solis ↔ Nox */
    esferaToggle() {
      if (!ctx) return;
      const esNox = ambienteActual === 'caos';
      if (!esNox) {
        // Solis→Nox: glissando descendente
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.4);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
        osc.connect(gain); gain.connect(masterGain);
        osc.start(); osc.stop(ctx.currentTime + 0.55);
      } else {
        // Nox→Solis: acorde mayor ascendente
        [261.63, 329.63, 392.00, 523.25].forEach((f, i) => {
          setTimeout(() => tocar(f, 0.5, 'sine', 0.1), i * 40);
        });
      }
    },

    /** Recoger ítem */
    obtenerItem() {
      if (!ctx) return;
      [523.25, 659.25, 783.99, 1046.50].forEach((f, i) => {
        setTimeout(() => tocar(f, 0.35, 'sine', 0.08), i * 55);
      });
    },

    /** Ataque en combate */
    combateAtaque() {
      if (!ctx) return;
      ruido(0.15, 2000, 0.25);
      tocar(180, 0.2, 'sawtooth', 0.12);
    },

    /** Impacto recibido */
    combateImpacto() {
      if (!ctx) return;
      ruido(0.2, 600, 0.3);
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(300, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.35);
      osc.connect(gain); gain.connect(masterGain);
      osc.start(); osc.stop(ctx.currentTime + 0.4);
    },

    /** Victoria en combate */
    combateVictoria() {
      if (!ctx) return;
      const melodia = [523.25, 659.25, 783.99, 1046.50, 880, 1046.50];
      const tiempos = [0, 120, 240, 360, 500, 620];
      melodia.forEach((f, i) => {
        setTimeout(() => tocar(f, 0.5, 'sine', 0.13), tiempos[i]);
      });
    },

    /** Derrota / muerte */
    combateDerrota() {
      if (!ctx) return;
      [392.00, 349.23, 311.13, 261.63, 220.00].forEach((f, i) => {
        setTimeout(() => tocar(f, 0.7, 'sawtooth', 0.1), i * 150);
      });
      setTimeout(() => ruido(0.8, 200, 0.15), 600);
    },

    /** Activar espejo (puzzle) */
    espejo() {
      if (!ctx) return;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 0.25);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
      osc.connect(gain); gain.connect(masterGain);
      osc.start(); osc.stop(ctx.currentTime + 0.45);
    },

    /** Secuencia de espejos correcta */
    espejoCorrecto() {
      if (!ctx) return;
      [523.25, 783.99, 1046.50].forEach((f, i) => {
        setTimeout(() => tocar(f, 0.6, 'sine', 0.1), i * 100);
      });
      setTimeout(() => ruido(0.3, 3000, 0.08), 300);
    },

    /** Error en secuencia de espejos */
    espejoError() {
      if (!ctx) return;
      tocar(150, 0.4, 'square', 0.2);
      setTimeout(() => tocar(120, 0.5, 'square', 0.15), 150);
    },

    /** Transición entre nodos narrativos */
    transicion() {
      if (!ctx) return;
      const gain = ctx.createGain();
      gain.connect(masterGain);
      ruido(0.6, 400, 0.04);
      tocar(ESCALAS[ambienteActual || 'solis'][0], 1.2, 'sine', 0.05, gain);
    },

    /** Partida guardada */
    guardado() {
      if (!ctx) return;
      [880, 1108.73].forEach((f, i) => {
        setTimeout(() => tocar(f, 0.3, 'sine', 0.07), i * 80);
      });
    },

    /** Purificar alma (Solis) — coro ascendente */
    purificarAlma() {
      if (!ctx) return;
      const rev = crearReverb(2, 4);
      rev.connect(masterGain);
      [261.63, 329.63, 392.00, 523.25, 659.25].forEach((f, i) => {
        setTimeout(() => tocar(f, 1.2, 'sine', 0.08, rev), i * 90);
      });
    },

    /** Absorber alma (Nox) — glissando perturbador */
    absorberAlma() {
      if (!ctx) return;
      const rev  = crearReverb(3, 2);
      rev.connect(masterGain);
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(55, ctx.currentTime + 1.5);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.7);
      osc.connect(gain); gain.connect(rev); gain.connect(masterGain);
      osc.start(); osc.stop(ctx.currentTime + 1.8);
      ruido(1.5, 300, 0.1);
    },
  };

  // ════════════════════════════════════════════════════
  // API PÚBLICA
  // ════════════════════════════════════════════════════

  function iniciar() {
    if (inicializado) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.7;
      masterGain.connect(ctx.destination);
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
    setTimeout(() => iniciarAmbiente(modo), 400);
  }

  function silenciar() {
    if (!ctx) return;
    silenciado = !silenciado;
    rampGain(masterGain, silenciado ? 0 : 0.7, 0.3);
    return silenciado;
  }

  function destruir() {
    detenerAmbiente(0.5);
    setTimeout(() => { if (ctx) { ctx.close(); ctx = null; inicializado = false; } }, 600);
  }

  // ── Auto-init al primer gesto del usuario ──────────
  // (necesario por políticas de autoplay de los navegadores)
  function _setupAutoInit() {
    const eventos = ['touchstart', 'mousedown', 'keydown'];
    function handler() {
      iniciar();
      eventos.forEach(ev => document.removeEventListener(ev, handler));
    }
    eventos.forEach(ev => document.addEventListener(ev, handler, { once: true }));
  }

  // Integración automática con el juego (si ya está cargado)
  function _integrarConJuego() {
    // Detectar cambio de esfera desde el toggle del juego
    const toggle = document.getElementById('esfera-toggle');
    if (toggle) {
      const original = window.cambiarEsfera;
      if (typeof original === 'function') {
        window.cambiarEsfera = function (...args) {
          fx.esferaToggle();
          const result = original.apply(this, args);
          // Sincronizar ambiente tras el cambio de estado
          setTimeout(() => {
            const esfera = window.estado?.esfera;
            if (esfera === 'caos') setAmbiente('caos');
            else if (esfera === 'solis') setAmbiente('solis');
          }, 200);
          return result;
        };
      }
    }

    // Detectar clics en opciones narrativas
    document.addEventListener('click', e => {
      if (e.target.matches('.opcion-btn, .combat-btn')) fx.click();
    });

    // Detectar toasts de ítem obtenido
    const toastEl = document.getElementById('toast');
    if (toastEl) {
      const obs = new MutationObserver(() => {
        if (toastEl.classList.contains('visible')) fx.obtenerItem();
      });
      obs.observe(toastEl, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // Inicialización al cargar el DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { _setupAutoInit(); _integrarConJuego(); });
  } else {
    _setupAutoInit();
    _integrarConJuego();
  }

  return { iniciar, setAmbiente, silenciar, destruir, fx };
})();

// Exportar para módulos si se usa en entorno Node/bundler
if (typeof module !== 'undefined' && module.exports) module.exports = Sonidos;
