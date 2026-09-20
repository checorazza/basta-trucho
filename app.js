/* ══════════════════════════════════════════════════════════════
   BASTA de Mesa — controlador de partida
   La app no guarda ni valida palabras: sólo sortea la letra,
   corre el reloj y corta la ronda.
   ══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  /* ── Letras ──────────────────────────────────────────────────
     Un solo anillo, en orden alfabético y pegadas entre sí.
     Sin K, Ñ, Q, W, X, Y ni Z: en una mesa no dan juego. */
  const ALL = ['A','B','C','D','E','F','G','H','I','J',
               'L','M','N','O','P','R','S','T','U','V'];

  /* ── Categorías ──────────────────────────────────────────────
     Las de fábrica viven en categorias.json, que es el único lugar
     donde se editan. Se suman las que escriba la gente en el inicio. */
  let PRESET_CATS = [];
  const CAT_MAX = 40;

  /* Al publicar, el JSON se inyecta dentro de la página: así la versión
     online no depende de fetch, que el CSP puede bloquear. Servida por
     HTTP se lee el archivo; con file:// no hay forma y se juega sin
     categorías, sin inventar una lista paralela que se desincronice. */
  async function cargarCategorias() {
    const inline = document.getElementById('categorias-json');
    if (inline) {
      try { return leerCats(JSON.parse(inline.textContent)); } catch (e) {}
    }
    try {
      const r = await fetch('categorias.json');
      if (r.ok) return leerCats(await r.json());
    } catch (e) {}
    console.warn('No se pudo leer categorias.json: serví la app por HTTP, no con file://');
    return [];
  }
  function leerCats(data) {
    const lista = data && Array.isArray(data.categorias) ? data.categorias : [];
    return lista.filter(c => typeof c === 'string' && c.trim()).map(limpiarCat);
  }

  /* ── Modos ───────────────────────────────────────────────────
     Normal: todas las rondas duran lo configurado.
     Contrarreloj: cada CONTRA_CADA letras el reloj baja un escalón,
     hasta el piso. El escalón es proporcional al tiempo inicial, si no
     una partida de 60s tardaría ochenta rondas en notarse. */
  /* Colchón por la transición: entre que se toca la letra y aparece la ronda
     la gente mira la cortina, no el reloj. Nunca deja la ronda por encima de
     su propia duración, así el cartel no muestra más segundos de los que dura. */
  const GRACIA_MS = 600;

  const CONTRA_CADA = 3;
  const pasoContra = () => Math.max(1, Math.round(state.duration * 0.15));

  const DUR_MIN = 5;      // pedido explícito
  const DUR_DEF = 10;     // con el que arranca la primera partida
  const DUR_MAX = 120;    // tope de sentido común: dos minutos
  const RING_LENGTH = 2 * Math.PI * 92;   // r=92 en el viewBox del reloj
  // Segundos de tensión final: 3, salvo en rondas cortas donde serían casi
  // toda la ronda (con 5s pintaría 3 de rojo).
  const urgentAt = () => Math.min(3, Math.max(1, Math.ceil(state.roundDur / 3)));

  // Lo que dura la ronda que está por empezar.
  function duracionRonda() {
    if (state.mode !== 'contra') return state.duration;
    const nivel = Math.floor(state.played / CONTRA_CADA);
    return Math.max(DUR_MIN, state.duration - nivel * pasoContra());
  }

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'), wipe: $('wipe'), wipeWord: $('wipe-word'),
    scenes: {
      inicio: $('scene-inicio'),
      preparando: $('scene-preparando'),
      activa: $('scene-activa'),
      fin: $('scene-fin'),
      victoria: $('scene-victoria')
    },
    empezar: $('btn-empezar'),
    durMenos: $('dur-menos'), durMas: $('dur-mas'), durValor: $('dur-valor'),
    lblDuracion: $('lbl-duracion'),
    modoNormal: $('modo-normal'), modoContra: $('modo-contra'), modoAyuda: $('modo-ayuda'),
    sonido: $('btn-sonido'), sonidoEstado: $('sonido-estado'),
    catSelect: $('cat-select'), catDel: $('cat-del'),
    catForm: $('cat-form'), catInput: $('cat-input'),
    catWheel: $('cat-wheel'), catRound: $('cat-round'),
    wheel: $('wheel'), wheelLetters: $('wheel-letters'), azar: $('btn-azar'),
    wheelProgress: $('wheel-progress'), wheelSeconds: $('wheel-seconds'),
    kickerWheel: $('kicker-wheel'), salir: $('btn-salir'),
    dial: $('dial'), progress: $('dial-progress'),
    roundLetter: $('round-letter'), seconds: $('round-seconds'),
    basta: $('btn-basta'),
    pausa: $('pausa'), pausaSeconds: $('pausa-seconds'), seguir: $('btn-seguir'),
    pausaBtns: [...document.querySelectorAll('.pausa-btn')],
    nuevaPartida: $('btn-nueva-partida'),
    winTime: $('win-time'), otra: $('btn-otra')
  };

  const state = {
    phase: 'inicio',
    duration: DUR_DEF,   // lo configurado; en contrarreloj es el arranque
    roundDur: DUR_DEF,   // lo que dura la ronda en curso
    mode: 'normal',
    played: 0,           // letras jugadas en esta partida
    gameStart: 0,        // para el tiempo total de la victoria
    pausedMs: 0,         // pausas acumuladas, no cuentan como juego
    pauseAt: 0,
    bajo: false,         // el reloj acaba de bajar un escalón
    sound: true,
    category: '',
    myCats: [],
    letter: null,
    used: new Set(),
    endsAt: 0,
    paused: false,
    frozen: false,    // congelado por la ruleta, sin overlay
    leftMs: 0,        // lo que quedaba del reloj al pausar o congelar
    raf: 0,
    endTimer: 0,      // respaldo del corte, vive a través del cambio de escena
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
    nope() {                        // letra ya jugada: grave y cayendo
      this.tone({ freq: 190, dur: 0.09, type: 'square', gain: 0.16 });
      this.tone({ freq: 135, dur: 0.14, type: 'square', gain: 0.16, at: 0.08 });
    },
    menos() {                       // el reloj bajó un escalón: dos tonos cayendo
      this.tone({ freq: 740, dur: 0.14, type: 'triangle', gain: 0.18 });
      this.tone({ freq: 440, dur: 0.22, type: 'triangle', gain: 0.18, at: 0.13 });
      this.noise({ dur: 0.25, gain: 0.05, cutoff: 700, at: 0.1 });
    },
    basta() {
      this.noise({ dur: 0.22, gain: 0.3, cutoff: 2600 });
      this.tone({ freq: 160, to: 42, dur: 0.42, type: 'sawtooth', gain: 0.3 });
      this.tone({ freq: 330, dur: 0.16, type: 'square', gain: 0.18, at: 0.02 });
    },
    victoria() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        this.tone({ freq: f, dur: 0.2, type: 'triangle', gain: 0.2, at: i * 0.12 }));
      [523.25, 659.25, 783.99, 1318.5].forEach(f =>            // acorde final
        this.tone({ freq: f, dur: 0.95, type: 'triangle', gain: 0.12, at: 0.52 }));
      this.noise({ dur: 0.5, gain: 0.05, cutoff: 1300, at: 0.5 });
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
      if (Number.isFinite(d) && d >= DUR_MIN && d <= DUR_MAX) state.duration = d;
      state.sound = localStorage.getItem('basta:sonido') !== '0';
      if (localStorage.getItem('basta:modo') === 'contra') state.mode = 'contra';
      const mias = JSON.parse(localStorage.getItem('basta:misCategorias') || '[]');
      if (Array.isArray(mias)) {
        state.myCats = mias.filter(c => typeof c === 'string' && c.trim())
                           .map(c => limpiarCat(c)).slice(0, 12);
      }
      // Se valida en resolverCategoria(), cuando ya está cargado el JSON.
      state.category = localStorage.getItem('basta:categoria') || '';
    } catch (e) { /* modo privado o dato roto: valores por defecto */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem('basta:duracion', String(state.duration));
      localStorage.setItem('basta:sonido', state.sound ? '1' : '0');
      localStorage.setItem('basta:modo', state.mode);
      localStorage.setItem('basta:categoria', state.category);
      localStorage.setItem('basta:misCategorias', JSON.stringify(state.myCats));
    } catch (e) {}
  }
  function paintPrefs() {
    const contra = state.mode === 'contra';
    el.modoNormal.setAttribute('aria-pressed', String(!contra));
    el.modoContra.setAttribute('aria-pressed', String(contra));
    el.modoAyuda.hidden = !contra;
    el.modoAyuda.textContent = contra
      ? 'Cada ' + CONTRA_CADA + ' letras el reloj baja ' + pasoContra() +
        's, hasta un piso de ' + DUR_MIN + 's.'
      : '';
    el.lblDuracion.textContent = contra ? 'Duración inicial' : 'Duración de la ronda';

    el.durValor.textContent = String(state.duration);
    el.durMenos.disabled = state.duration <= DUR_MIN;
    el.durMas.disabled = state.duration >= DUR_MAX;
    el.sonido.setAttribute('aria-pressed', String(state.sound));
    el.sonidoEstado.textContent = state.sound ? 'SÍ' : 'NO';
  }

  /* ── Categorías ──────────────────────────────────────────────── */
  const limpiarCat = (s) => s.replace(/\s+/g, ' ').trim().slice(0, CAT_MAX);
  const todasLasCats = () => PRESET_CATS.concat(state.myCats);

  const esPropia = (cat) => !!cat && !PRESET_CATS.includes(cat);
  const hayCats = () => todasLasCats().length > 0;

  // La guardada puede no existir más (la borraron o cambió el JSON).
  function resolverCategoria() {
    const todas = todasLasCats();
    if (!todas.includes(state.category)) state.category = todas[0] || '';
  }

  function renderCats() {
    el.catSelect.textContent = '';
    const opcion = (cat) => {
      const o = document.createElement('option');
      o.value = cat;
      o.textContent = cat;                        // textContent: nunca innerHTML
      return o;
    };
    // Siempre agrupadas, aunque no haya propias: sin optgroup el navegador
    // dibuja las opciones en negrita y sin sangría, y la lista cambiaba de
    // aspecto justo al crear la primera categoría propia.
    const grupo = (label, lista) => {
      if (!lista.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      lista.forEach(c => g.appendChild(opcion(c)));
      el.catSelect.appendChild(g);
    };
    grupo('Predeterminadas', PRESET_CATS);
    grupo('Mis categorías', state.myCats);
    el.catSelect.value = state.category;
    el.catDel.hidden = !esPropia(state.category);
    el.catSelect.disabled = !hayCats();
  }

  /* Sin categorías (sólo pasa si no se pudo leer el JSON) se esconden
     las tarjetas y el juego sigue andando con la letra y el reloj. */
  function paintCategory() {
    el.catWheel.textContent = state.category;
    el.catRound.textContent = state.category;
    document.querySelectorAll('.cat-card').forEach(c => { c.hidden = !state.category; });
  }

  function addCat(texto) {
    const cat = limpiarCat(texto);
    if (!cat) return false;
    const yaEsta = todasLasCats().find(c => c.toLowerCase() === cat.toLowerCase());
    if (yaEsta) { state.category = yaEsta; }      // repetida: la elige y listo
    else {
      if (state.myCats.length >= 12) state.myCats.shift();
      state.myCats.push(cat);
      state.category = cat;
    }
    savePrefs(); renderCats(); paintCategory();
    return true;
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
    pintarPausa();
  }
  /* Con `word`, la cortina se queda un momento y canta la palabra:
     así BASTA se ve claro sin una pantalla intermedia que frene el juego. */
  function wipeTo(fn, color, word, fast) {
    if (reduced()) { fn(); return; }
    const hold = !!word;
    el.wipeWord.textContent = word || '';
    el.wipe.style.setProperty('--wipe-color', color);
    el.wipe.classList.remove('is-active', 'wipe--hold', 'wipe--fast');
    void el.wipe.offsetWidth;
    if (hold) el.wipe.classList.add('wipe--hold');
    else if (fast) el.wipe.classList.add('wipe--fast');
    el.wipe.classList.add('is-active');
    // El cambio de escena va cuando la cortina tapa. En la larga va al
    // final del tapado, no al principio: detrás se rearma el reloj y no
    // puede empezar a correr un segundo antes de que se vea la rueda.
    later(fn, hold ? 2000 : (fast ? 180 : 280));
    later(() => el.wipe.classList.remove('is-active', 'wipe--hold', 'wipe--fast'),
          hold ? 2480 : (fast ? 480 : 700));
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
      node.classList.remove('is-flash', 'is-picked', 'is-nope');
      node.disabled = false;
    });
    const quedan = ALL.length - state.used.size;
    let texto;
    if (state.bajo)                   texto = '¡Menos tiempo! · ' + state.roundDur + 's';
    else if (state.mode === 'contra') texto = 'Elegí una letra · ' + state.roundDur + 's';
    else if (state.used.size === 0)   texto = 'Elegí una letra';
    else if (quedan === 0)            texto = 'Vuelven todas las letras';
    else                              texto = 'Elegí una letra · quedan ' + quedan;
    el.kickerWheel.textContent = texto;
    el.kickerWheel.classList.toggle('is-baja', state.bajo);
  }
  function lockWheel(locked) {
    tiles.forEach(n => { n.disabled = locked; });
    el.azar.disabled = locked;
  }

  /* ── Preparar ronda ──────────────────────────────────────────── */
  /* El reloj arranca acá, con la rueda: elegir la letra ya cuesta tiempo.
     No se reinicia al elegir; la ronda sigue con lo que quedó. */
  function toWheel() {
    clearTimers();
    stopClock();
    if (state.used.size >= ALL.length) state.used.clear();
    state.letter = null;
    const antes = state.roundDur;
    state.roundDur = duracionRonda();
    state.bajo = state.mode === 'contra' && state.played > 0 && state.roundDur < antes;
    paintWheel();
    lockWheel(false);

    el.wheel.classList.remove('is-urgent');
    el.dial.classList.remove('is-urgent');
    el.wheelSeconds.textContent = String(state.roundDur);
    el.wheelProgress.style.strokeDasharray = RING_LENGTH.toFixed(2);
    el.wheelProgress.style.strokeDashoffset = '0';
    el.progress.style.strokeDasharray = RING_LENGTH.toFixed(2);
    el.progress.style.strokeDashoffset = '0';

    show('preparando');
    startClock();
    if (state.bajo) sfx.menos(); else sfx.arrancar();
    keepAwake();
  }

  /* Sin argumento arranca de cero; con `restante` retoma una pausa. */
  function startClock(restante) {
    const ms = restante == null ? state.roundDur * 1000 : restante;
    if (restante == null) state.lastBeep = state.roundDur + 1;
    state.endsAt = performance.now() + ms;
    // rAF dibuja la cuenta; el setTimeout garantiza el corte aunque el
    // navegador congele los frames con la pestaña en segundo plano.
    clearTimeout(state.endTimer);
    state.endTimer = setTimeout(() => {
      if (state.phase === 'preparando' || state.phase === 'activa') endRound();
    }, ms + 40);
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(tickClock);
  }

  // La letra queda registrada en el toque, no al arrancar la ronda: si el
  // reloj vence durante la confirmación, el final igual muestra la elegida.
  function commitLetter(L) {
    state.letter = L;
    state.used.add(L);
    state.played++;           // el escalón de contrarreloj cuenta letras
  }

  function pickLetter(L) {
    if (state.phase !== 'preparando') return;
    if (state.used.has(L)) {          // ya jugada: se avisa y no pasa nada más
      const t = tiles.get(L);
      t.classList.add('is-nope');
      later(() => t.classList.remove('is-nope'), 220);
      sfx.nope();
      buzz(35);
      return;
    }
    lockWheel(true);
    const tile = tiles.get(L);
    tile.classList.add('is-picked');
    commitLetter(L);
    sfx.elegir();
    buzz(20);
    later(() => beginRound(L), reduced() ? 60 : 170);
  }

  function spin() {
    if (state.phase !== 'preparando') return;
    lockWheel(true);
    congelarReloj();
    const pool = ALL.filter(L => !state.used.has(L));
    const target = pool[Math.floor(Math.random() * pool.length)];
    if (reduced()) { tiles.get(target).classList.add('is-picked'); commitLetter(target);
      sfx.elegir(); later(() => beginRound(target), 300); return; }

    // La ruleta recorre el anillo frenando y aterriza justo en la letra sorteada.
    // Con el reloj congelado no cuesta ronda, así que da casi dos vueltas
    // y frena largo: 38 pasos sobre un anillo de 20.
    const steps = 38;
    const target_i = ALL.indexOf(target);
    const from = ((target_i - (steps - 1)) % ALL.length + ALL.length) % ALL.length;
    let delay = 22, acc = 0, prev = null;
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
      delay *= 1.072;
    }
    later(() => {
      if (prev) prev.classList.remove('is-flash');
      tiles.get(target).classList.add('is-picked');
      commitLetter(target);
      sfx.elegir();
      buzz(30);
    }, acc);
    later(() => beginRound(target), acc + 520);
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

  /* El reloj ya viene corriendo desde la rueda: acá sólo cambia de escena. */
  function beginRound(L) {
    clearTimers();
    state.letter = L;
    state.used.add(L);
    congelarReloj();      // la cortina no se cobra; con la ruleta ya viene congelado

    // Congelado por la ruleta, endsAt quedó en el pasado: vale lo guardado.
    const left = state.frozen ? state.leftMs
                              : Math.max(0, state.endsAt - performance.now());
    el.roundLetter.textContent = L;
    el.seconds.textContent = String(Math.ceil(left / 1000));
    el.progress.style.strokeDashoffset =
      (RING_LENGTH * (1 - left / (state.roundDur * 1000))).toFixed(2);
    el.dial.classList.toggle('is-urgent', left / 1000 <= urgentAt());
    el.basta.disabled = false;
    el.basta.classList.remove('is-slammed');

    wipeTo(() => { show('activa'); descongelarReloj(); }, 'var(--papel)', null, true);
  }

  function tickClock(now) {
    const enRueda = state.phase === 'preparando';
    if (!enRueda && state.phase !== 'activa') return;

    const left = state.endsAt - now;
    if (left <= 0) { endRound(); return; }

    // Mismo reloj, dos caras: el anillo de la rueda o el del disco.
    const secEl  = enRueda ? el.wheelSeconds  : el.seconds;
    const ringEl = enRueda ? el.wheelProgress : el.progress;
    const hostEl = enRueda ? el.wheel         : el.dial;

    const secs = Math.ceil(left / 1000);
    if (secEl.textContent !== String(secs)) secEl.textContent = String(secs);
    ringEl.style.strokeDashoffset =
      (RING_LENGTH * (1 - left / (state.roundDur * 1000))).toFixed(2);

    if (secs <= urgentAt()) {
      hostEl.classList.add('is-urgent');
      if (secs < state.lastBeep) { state.lastBeep = secs; sfx.cuenta(); }
    }
    state.raf = requestAnimationFrame(tickClock);
  }

  function stopClock() {
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    clearTimeout(state.endTimer);
    state.endTimer = 0;
    state.paused = false;
    state.frozen = false;
    pintarPausa();
  }

  /* ── Pausa ───────────────────────────────────────────────────── */
  function pintarPausa() {
    const enJuego = state.phase === 'preparando' || state.phase === 'activa';
    el.pausaBtns.forEach(b => { b.hidden = !enJuego || state.paused || state.frozen; });
    el.pausa.hidden = !state.paused;
  }

  /* La ruleta no debe comerse la ronda: el reloj se congela mientras gira
     y vuelve a correr cuando aparece la pantalla con la letra. Sin overlay,
     es una pausa interna. */
  function congelarReloj() {
    if (state.frozen) return;
    state.frozen = true;
    state.leftMs = Math.max(0, state.endsAt - performance.now());
    cancelAnimationFrame(state.raf); state.raf = 0;
    clearTimeout(state.endTimer);   state.endTimer = 0;
    pintarPausa();
  }
  function descongelarReloj() {
    if (!state.frozen) return;
    state.frozen = false;
    startClock(Math.min(state.roundDur * 1000, state.leftMs + GRACIA_MS));
    pintarPausa();
  }

  function pausar() {
    if (state.paused || state.frozen) return;
    state.pauseAt = performance.now();
    if (state.phase !== 'preparando' && state.phase !== 'activa') return;
    state.paused = true;
    state.leftMs = Math.max(0, state.endsAt - performance.now());
    cancelAnimationFrame(state.raf); state.raf = 0;
    clearTimeout(state.endTimer);   state.endTimer = 0;
    el.pausaSeconds.textContent = String(Math.ceil(state.leftMs / 1000));
    pintarPausa();
    sfx.tick();
  }

  function seguir() {
    if (!state.paused) return;
    state.pausedMs += performance.now() - state.pauseAt;
    state.paused = false;
    pintarPausa();
    sfx.elegir();
    startClock(state.leftMs);
  }

  /* BASTA corta la ronda y vuelve derecho a la rueda: no hay pantalla de fin,
     que es sólo para cuando se agota el reloj. */
  function hitBasta() {
    if (state.phase !== 'activa') return;          // un solo BASTA por ronda
    el.basta.disabled = true;
    el.basta.classList.add('is-slammed');
    state.phase = 'cortada';                       // el reloj deja de correr acá
    stopClock();
    clearTimers();
    el.dial.classList.remove('is-urgent');
    sfx.basta();
    buzz([40, 30, 90]);
    // Si era la última letra, detrás de la cortina aparece la victoria.
    const gano = state.used.size >= ALL.length;
    wipeTo(gano ? victoria : toWheel, 'var(--rojo)', '¡BASTA!');
  }

  /* Única salida a la pantalla de fin: se acabó el tiempo. */
  function endRound() {
    state.phase = 'fin';
    stopClock();
    clearTimers();
    releaseAwake();
    el.dial.classList.remove('is-urgent');
    el.wheel.classList.remove('is-urgent');

    sfx.tiempo();
    buzz([120, 80, 120]);
    el.seconds.textContent = '0';
    el.wheelSeconds.textContent = '0';

    el.nuevaPartida.disabled = true;
    el.nuevaPartida.classList.remove('is-arming');

    wipeTo(() => {
      show('fin');
      // Arma el botón con un instante de demora, para que nadie lo toque de rebote.
      void el.nuevaPartida.offsetWidth;
      el.nuevaPartida.classList.add('is-arming');
      later(() => {
        el.nuevaPartida.disabled = false;
        el.nuevaPartida.classList.remove('is-arming');
      }, 800);
    }, 'var(--rojo)');
  }

  /* Se jugaron todas las letras: ganaron. */
  function victoria() {
    state.phase = 'victoria';
    stopClock();
    clearTimers();
    releaseAwake();
    el.dial.classList.remove('is-urgent');
    el.wheel.classList.remove('is-urgent');

    const total = Math.max(0, performance.now() - state.gameStart - state.pausedMs);
    const seg = Math.round(total / 1000);
    el.winTime.textContent = Math.floor(seg / 60) + ':' + String(seg % 60).padStart(2, '0');

    sfx.victoria();
    buzz([30, 60, 30, 60, 120]);

    el.otra.disabled = true;
    el.otra.classList.remove('is-arming');
    show('victoria');
    void el.otra.offsetWidth;
    el.otra.classList.add('is-arming');
    later(() => {
      el.otra.disabled = false;
      el.otra.classList.remove('is-arming');
    }, 800);
  }

  /* ── Salidas ─────────────────────────────────────────────────── */
  function toHome() {
    clearTimers();
    stopClock();
    releaseAwake();
    state.used.clear();
    state.letter = null;
    state.played = 0;
    state.bajo = false;
    state.pausedMs = 0;
    state.roundDur = state.duration;
    el.wheel.classList.remove('is-urgent');
    el.dial.classList.remove('is-urgent');
    wipeTo(() => show('inicio'), 'var(--ink-700)');
  }

  /* ── Eventos ─────────────────────────────────────────────────── */
  el.empezar.addEventListener('click', () => {
    sfx.ready();                 // desbloquea el audio con el primer gesto
    sfx.elegir();
    state.gameStart = performance.now();
    state.pausedMs = 0;
    wipeTo(toWheel, 'var(--rojo)');
  });

  /* Un toque mueve un segundo; mantenerlo apretado repite, porque de 5
     a 60 serían 55 toques. */
  function pasoDuracion(delta) {
    const v = Math.min(DUR_MAX, Math.max(DUR_MIN, state.duration + delta));
    if (v === state.duration) return;
    state.duration = v;
    savePrefs(); paintPrefs(); sfx.tick();
  }
  function conRepeticion(btn, delta) {
    let espera = 0, repite = 0;
    const parar = () => { clearTimeout(espera); clearInterval(repite); };
    btn.addEventListener('pointerdown', () => {
      parar();
      espera = setTimeout(() => { repite = setInterval(() => pasoDuracion(delta), 110); }, 450);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(ev =>
      btn.addEventListener(ev, parar));
    btn.addEventListener('click', () => pasoDuracion(delta));   // cubre teclado también
  }
  conRepeticion(el.durMenos, -1);
  conRepeticion(el.durMas, +1);

  const ponerModo = (m) => () => {
    if (state.mode === m) return;
    state.mode = m;
    savePrefs(); paintPrefs(); sfx.tick();
  };
  el.modoNormal.addEventListener('click', ponerModo('normal'));
  el.modoContra.addEventListener('click', ponerModo('contra'));

  el.catSelect.addEventListener('change', () => {
    state.category = el.catSelect.value;
    savePrefs(); paintCategory(); sfx.tick();
    el.catDel.hidden = !esPropia(state.category);
  });

  el.catDel.addEventListener('click', () => {
    const cat = state.category;
    if (!esPropia(cat)) return;
    state.myCats = state.myCats.filter(c => c !== cat);
    resolverCategoria();
    savePrefs(); renderCats(); paintCategory(); sfx.tick();
  });

  el.catForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (addCat(el.catInput.value)) {
      el.catInput.value = '';
      el.catInput.blur();                 // baja el teclado del celular
      sfx.elegir();
    }
  });

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
  el.pausaBtns.forEach(b => b.addEventListener('click', pausar));
  el.seguir.addEventListener('click', seguir);
  el.otra.addEventListener('click', () => {
    if (el.otra.disabled) return;
    sfx.tick();
    toHome();
  });

  // Al agotarse el tiempo se termina la partida: vuelve a la pantalla inicial.
  el.nuevaPartida.addEventListener('click', () => {
    if (el.nuevaPartida.disabled) return;
    sfx.tick();
    toHome();
  });

  // Teclado: útil cuando la partida se juega en una pantalla compartida.
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (state.paused) {
      if (e.code === 'Space' || e.code === 'Enter' || e.key === 'Escape') { e.preventDefault(); seguir(); }
      return;
    }
    if (state.phase === 'activa' && (e.code === 'Space' || e.code === 'Enter' || e.key === 'b' || e.key === 'B')) {
      e.preventDefault(); hitBasta();
    } else if (state.phase === 'preparando' && e.key === 'Escape') {
      toHome();
    }
  });

  // Si vuelven a la pestaña con la pantalla bloqueada, recupera el wake lock.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' &&
        (state.phase === 'preparando' || state.phase === 'activa')) keepAwake();
  });

  /* ── Arranque ────────────────────────────────────────────────── */
  loadPrefs();
  paintPrefs();
  buildWheel();
  show('inicio');
  cargarCategorias().then(cats => {
    PRESET_CATS = cats;
    resolverCategoria();
    renderCats();
    paintCategory();
  });
})();
