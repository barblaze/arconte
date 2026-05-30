const Sonidos = (() => {
  'use strict';

  let ctx, masterGain, compressor, ambienteActual, silenciado, inicializado;
  let buffers = {};
  let loopNodes = { source: null, gain: null };

  function ahora() { return ctx.currentTime; }

  function conectar(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) {
      if (nodes[i]) nodes[i].connect(nodes[i + 1]);
    }
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
    click() {},
    esferaToggle() {},
    obtenerItem() {},
    combateAtaque() {},
    combateImpacto() {},
    combateVictoria() {},
    combateDerrota() {},
    espejo() {},
    espejoCorrecto() {},
    espejoError() {},
    transicion() {},
    guardado() {},
    purificarAlma() {},
    absorberAlma() {},
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
