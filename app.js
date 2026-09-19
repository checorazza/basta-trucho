/* ══════════════════════════════════════════════════════════════
   BASTA de Mesa — controlador de partida
   La app no guarda ni valida palabras: sólo sortea la letra,
   corre el reloj y corta la ronda.
   ══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  /* ── Letras ──────────────────────────────────────────────────
     Un solo anillo, en orden alfabético y pegadas entre sí.
     Sin K, Ñ, W, X, Y ni Z: en una mesa no dan juego. */
  const ALL = ['A','B','C','D','E','F','G','H','I','J','L',
               'M','N','O','P','Q','R','S','T','U','V'];

  const DURATIONS = [10, 15];
  const RING_LENGTH = 2 * Math.PI * 92;   // r=92 en el viewBox del reloj
  const URGENT_AT = 3;                    // segundos de tensión final

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'), wipe: $('wipe'),
    scenes: {
      inicio: $('scene-inicio'),
      preparando: $('scene-preparando'),
      activa: $('scene-activa'),
      fin: $('scene-fin')
    },
    empezar: $('btn-empezar'),
    chips: [...document.querySelectorAll('#chips-duracion .chip')],
    sonido: $('btn-sonido'), sonidoEstado: $('sonido-estado'),
    wheelLetters: $('wheel-letters'), azar: $('btn-azar'),
    kickerWheel: $('kicker-wheel'), salir: $('btn-salir'),
    dial: $('dial'), progress: $('dial-progress'),
    roundLetter: $('round-letter'), seconds: $('round-seconds'),
    basta: $('btn-basta'),
    finScene: $('scene-fin'), endTitle: $('end-title'), endSub: $('end-sub'),
    endLetter: $('end-letter'), nueva: $('btn-nueva'), inicio: $('btn-inicio')
  };

  const state = {
    phase: 'inicio',
    duration: 15,
    sound: true,
    letter: null,
    used: new Set(),
    endsAt: 0,
    raf: 0,
    lastBeep: 0,
    timers: []
  };

  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const later = (fn, ms) => { const t = setTimeout(fn, ms); state.timers.push(t); return t; };
  const clearTimers = () => { state.timers.forEach(clearTimeout); state.timers = []; };

  /* ── Sonido sintetizado (sin archivos) ───────────────────────── */
  const sfx = {
    ctx: null,
    ready() {
      if (!state.sound) return null;
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
      } catch (e) { return null; }
    },
    tone(o) {
      const ctx = this.ready(); if (!ctx) return;
      const t0 = ctx.currentTime + (o.at || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = o.type || 'square';
      osc.frequency.setValueAtTime(o.freq, t0);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + o.dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(o.gain || 0.18, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + o.dur + 0.02);
    },
    noise(o) {
      const ctx = this.ready(); if (!ctx) return;
      const t0 = ctx.currentTime + (o.at || 0);
      const frames = Math.floor(ctx.sampleRate * o.dur);
      const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = o.cutoff || 1800;
      const gain = ctx.createGain(); gain.gain.value = o.gain || 0.2;
      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start(t0);
    },

    tick()  { this.tone({ freq: 1500, dur: 0.03, type: 'square', gain: 0.07 }); },
    ruleta(){ this.tone({ freq: 900,  dur: 0.04, type: 'square', gain: 0.11 }); },
    elegir(){ this.tone({ freq: 660, dur: 0.09, type: 'square', gain: 0.16 });
              this.tone({ freq: 990, dur: 0.14, type: 'square', gain: 0.16, at: 0.09 }); },
    arrancar() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        this.tone({ freq: f, dur: 0.13, type: 'triangle', gain: 0.17, at: i * 0.075 }));
      this.noise({ dur: 0.3, gain: 0.06, cutoff: 900, at: 0.05 });
    },
    cuenta() { this.tone({ freq: 1200, dur: 0.045, type: 'sine', gain: 0.13 }); },
    basta() {
      this.noise({ dur: 0.22, gain: 0.3, cutoff: 2600 });
      this.tone({ freq: 160, to: 42, dur: 0.42, type: 'sawtooth', gain: 0.3 });
      this.tone({ freq: 330, dur: 0.16, type: 'square', gain: 0.18, at: 0.02 });
    },
    tiempo() {
      for (let i = 0; i < 3; i++) {
        const at = i * 0.24;
        this.tone({ freq: 233, dur: 0.17, type: 'sawtooth', gain: 0.2, at });
        this.tone({ freq: 220, dur: 0.17, type: 'square',   gain: 0.16, at });
      }
    }
  };

  const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };

  /* ── Preferencias ────────────────────────────────────────────── */
  function loadPrefs() {
    try {
      const d = parseInt(localStorage.getItem('basta:duracion'), 10);
      if (DURATIONS.includes(d)) state.duration = d;
      state.sound = localStorage.getItem('basta:sonido') !== '0';
    } catch (e) { /* modo privado: valores por defecto */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem('basta:duracion', String(state.duration));
      localStorage.setItem('basta:sonido', state.sound ? '1' : '0');
    } catch (e) {}
  }
  function paintPrefs() {
    el.chips.forEach(c => c.setAttribute('aria-pressed', String(+c.dataset.dur === state.duration)));
    el.sonido.setAttribute('aria-pressed', String(state.sound));
    el.sonidoEstado.textContent = state.sound ? 'SÍ' : 'NO';
  }

  /* ── Escenas y cortina ───────────────────────────────────────── */
  function show(name) {
    state.phase = name;
    Object.entries(el.scenes).forEach(([k, node]) => { node.hidden = (k !== name); });
    // Reinicia las animaciones de entrada de la escena que aparece.
    const node = el.scenes[name];
    node.querySelectorAll('.wheel, .dial, .end__title').forEach(n => {
      n.style.animation = 'none'; void n.offsetWidth; n.style.animation = '';
    });
  }
  function wipeTo(fn, color) {
    if (reduced()) { fn(); return; }
    el.wipe.style.setProperty('--wipe-color', color);
    el.wipe.classList.remove('is-active');
    void el.wipe.offsetWidth;
    el.wipe.classList.add('is-active');
    later(fn, 280);
    later(() => el.wipe.classList.remove('is-active'), 700);
  }

  /* ── La rueda ────────────────────────────────────────────────── */
  const tiles = new Map();
  function buildWheel() {
    const frag = document.createDocumentFragment();
    const step = 360 / ALL.length;
    ALL.forEach((L, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'letter';
      b.textContent = L;
      b.dataset.letter = L;
      b.setAttribute('aria-label', 'Letra ' + L);
      b.style.setProperty('--a', (i * step).toFixed(3));
      frag.appendChild(b);
      tiles.set(L, b);
    });
    el.wheelLetters.appendChild(frag);
  }
  function paintWheel() {
    tiles.forEach((node, L) => {
      node.classList.toggle('is-used', state.used.has(L));
      node.classList.remove('is-flash', 'is-picked');
      node.disabled = false;
    });
    const quedan = ALL.length - state.used.size;
    el.kickerWheel.textContent = state.used.size === 0
      ? 'Elegí una letra'
      : (quedan === 0 ? 'Vuelven todas las letras' : 'Elegí una letra · quedan ' + quedan);
  }
  function lockWheel(locked) {
    tiles.forEach(n => { n.disabled = locked; });
    el.azar.disabled = locked;
  }

  /* ── Preparar ronda ──────────────────────────────────────────── */
  function toWheel() {
    clearTimers();
    if (state.used.size >= ALL.length) state.used.clear();
    paintWheel();
    lockWheel(false);
    show('preparando');
  }

  function pickLetter(L) {
    if (state.phase !== 'preparando') return;
    lockWheel(true);
    const tile = tiles.get(L);
    tile.classList.add('is-picked');
    sfx.elegir();
    buzz(20);
    later(() => beginRound(L), reduced() ? 60 : 520);
  }

  function spin() {
    if (state.phase !== 'preparando') return;
    lockWheel(true);
    const pool = ALL.filter(L => !state.used.has(L));
    const target = pool[Math.floor(Math.random() * pool.length)];
    if (reduced()) { tiles.get(target).classList.add('is-picked'); sfx.elegir();
      later(() => beginRound(target), 300); return; }

    // La ruleta recorre el anillo frenando y aterriza justo en la letra sorteada.
    const steps = 20;
    const target_i = ALL.indexOf(target);
    const from = ((target_i - (steps - 1)) % ALL.length + ALL.length) % ALL.length;
    let delay = 24, acc = 0, prev = null;
    for (let i = 0; i < steps; i++) {
      const node = tiles.get(ALL[(from + i) % ALL.length]);
      const last = prev;
      later(() => {
        if (last) last.classList.remove('is-flash');
        node.classList.add('is-flash');
        sfx.ruleta();
      }, acc);
      prev = node;
      acc += delay;
      delay *= 1.10;
    }
    later(() => {
      if (prev) prev.classList.remove('is-flash');
      tiles.get(target).classList.add('is-picked');
      sfx.elegir();
      buzz(30);
    }, acc);
    later(() => beginRound(target), acc + 480);
  }

  /* ── Ronda activa ────────────────────────────────────────────── */
  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) {}
  }
  function releaseAwake() {
    try { wakeLock && wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  function beginRound(L) {
    clearTimers();
    state.letter = L;
    state.used.add(L);
    state.lastBeep = state.duration + 1;

    el.roundLetter.textContent = L;
    el.seconds.textContent = String(state.duration);
    el.progress.style.strokeDasharray = RING_LENGTH.toFixed(2);
    el.progress.style.strokeDashoffset = '0';
    el.dial.classList.remove('is-urgent');
    el.basta.disabled = false;
    el.basta.classList.remove('is-slammed');

    wipeTo(() => {
      // El reloj arranca cuando la escena aparece, no cuando cae la cortina.
      state.endsAt = performance.now() + state.duration * 1000;
      show('activa');
      sfx.arrancar();
      keepAwake();
      // rAF dibuja la cuenta; el setTimeout garantiza el corte aunque el
      // navegador congele los frames con la pestaña en segundo plano.
      later(() => { if (state.phase === 'activa') endRound('tiempo'); }, state.duration * 1000 + 40);
      state.raf = requestAnimationFrame(tickRound);
    }, 'var(--menta)');
  }

  function tickRound(now) {
    if (state.phase !== 'activa') return;
    const left = state.endsAt - now;
    if (left <= 0) { endRound('tiempo'); return; }

    const secs = Math.ceil(left / 1000);
    if (el.seconds.textContent !== String(secs)) el.seconds.textContent = String(secs);
    el.progress.style.strokeDashoffset =
      (RING_LENGTH * (1 - left / (state.duration * 1000))).toFixed(2);

    if (secs <= URGENT_AT) {
      el.dial.classList.add('is-urgent');
      if (secs < state.lastBeep) { state.lastBeep = secs; sfx.cuenta(); }
    }
    state.raf = requestAnimationFrame(tickRound);
  }

  function hitBasta() {
    if (state.phase !== 'activa') return;          // un solo BASTA por ronda
    el.basta.disabled = true;
    el.basta.classList.add('is-slammed');
    endRound('basta');
  }

  function endRound(kind) {
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.phase = 'fin';                            // corta el reloj al instante
    clearTimers();
    releaseAwake();
    el.dial.classList.remove('is-urgent');

    if (kind === 'basta') { sfx.basta(); buzz([40, 30, 90]); }
    else { sfx.tiempo(); buzz([120, 80, 120]); el.seconds.textContent = '0'; }

    el.finScene.dataset.variant = kind;
    el.endTitle.textContent = kind === 'basta' ? '¡BASTA!' : '¡TIEMPO!';
    el.endSub.textContent = kind === 'basta'
      ? 'Se terminó el tiempo.'
      : 'Se acabaron los segundos.';
    el.endLetter.textContent = state.letter;

    el.nueva.disabled = true;
    el.nueva.classList.remove('is-arming');

    wipeTo(() => {
      show('fin');
      // Arma NUEVA RONDA recién después del golpe, para que nadie la toque de rebote.
      void el.nueva.offsetWidth;
      el.nueva.classList.add('is-arming');
      later(() => {
        el.nueva.disabled = false;
        el.nueva.classList.remove('is-arming');
      }, 800);
    }, kind === 'basta' ? 'var(--coral)' : 'var(--mango)');
  }

  /* ── Salidas ─────────────────────────────────────────────────── */
  function toHome() {
    clearTimers();
    cancelAnimationFrame(state.raf);
    releaseAwake();
    state.used.clear();
    wipeTo(() => show('inicio'), 'var(--uva)');
  }

  /* ── Eventos ─────────────────────────────────────────────────── */
  el.empezar.addEventListener('click', () => {
    sfx.ready();                 // desbloquea el audio con el primer gesto
    sfx.elegir();
    wipeTo(toWheel, 'var(--mango)');
  });

  el.chips.forEach(chip => chip.addEventListener('click', () => {
    state.duration = +chip.dataset.dur;
    savePrefs(); paintPrefs(); sfx.tick();
  }));

  el.sonido.addEventListener('click', () => {
    state.sound = !state.sound;
    savePrefs(); paintPrefs();
    if (state.sound) { sfx.ready(); sfx.elegir(); }
  });

  el.wheelLetters.addEventListener('click', (e) => {
    const b = e.target.closest('.letter');
    if (b && !b.disabled) pickLetter(b.dataset.letter);
  });
  el.azar.addEventListener('click', spin);
  el.salir.addEventListener('click', toHome);

  el.basta.addEventListener('click', hitBasta);
  el.nueva.addEventListener('click', () => {
    if (el.nueva.disabled) return;
    sfx.tick();
    wipeTo(toWheel, 'var(--menta)');
  });
  el.inicio.addEventListener('click', toHome);

  // Teclado: útil cuando la partida se juega en una pantalla compartida.
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (state.phase === 'activa' && (e.code === 'Space' || e.code === 'Enter' || e.key === 'b' || e.key === 'B')) {
      e.preventDefault(); hitBasta();
    } else if (state.phase === 'preparando' && e.key === 'Escape') {
      toHome();
    }
  });

  // Si vuelven a la pestaña con la pantalla bloqueada, recupera el wake lock.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.phase === 'activa') keepAwake();
  });

  /* ── Arranque ────────────────────────────────────────────────── */
  loadPrefs();
  paintPrefs();
  buildWheel();
  show('inicio');
})();
