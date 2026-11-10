/*!
 * GrokBot characters: code-driven, animated blob characters.
 * Recreated from the Grok Bot beta's public demo footage.
 *
 * Every shape is a signed distance function (SDF). It is sampled into a ring
 * of points by casting rays from the centre. Every shape has the same number
 * of points, so any shape can morph smoothly into any other. The points are
 * driven by springs, which gives the jelly-like wobble.
 *
 * No dependencies. Works as a plain <script> (window.GrokBot) or as CommonJS.
 *
 * Vendored into 并坐 from github.com/ThePeeps191/grok-bot-characters
 * (commit 49bde09, MIT, see grokbot.LICENSE). Local changes: the `eyeSize`
 * option, a multiplier on eye size (not on how far the eyes travel), because
 * the eyes read small at avatar sizes; and a bot is only updated as often as
 * what it is doing needs (see "Shared ticker"), where upstream redraws every
 * bot on every frame.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GrokBot = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const N = 72; // points per outline
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;

  /* ------------------------------------------------------------------ */
  /* SDF helpers (SVG coordinates: +y is down)                           */
  /* ------------------------------------------------------------------ */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const len = (x, y) => Math.sqrt(x * x + y * y);

  function smin(a, b, k) {
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - h * h * k * 0.25;
  }
  const circle = (cx, cy, r) => (x, y) => len(x - cx, y - cy) - r;
  const rotate = (f, a) => {
    const c = Math.cos(-a * DEG), s = Math.sin(-a * DEG);
    return (x, y) => f(x * c - y * s, x * s + y * c);
  };
  const translate = (f, dx, dy) => (x, y) => f(x - dx, y - dy);
  const round = (f, r) => (x, y) => f(x, y) - r;
  const sunion = (k, ...fs) => (x, y) => {
    let d = fs[0](x, y);
    for (let i = 1; i < fs.length; i++) d = smin(d, fs[i](x, y), k);
    return d;
  };

  function polygonSDF(v) {
    const n = v.length;
    return (px, py) => {
      let d = (px - v[0][0]) ** 2 + (py - v[0][1]) ** 2, s = 1;
      for (let i = 0, j = n - 1; i < n; j = i, i++) {
        const ex = v[j][0] - v[i][0], ey = v[j][1] - v[i][1];
        const wx = px - v[i][0], wy = py - v[i][1];
        const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
        const bx = wx - ex * t, by = wy - ey * t;
        d = Math.min(d, bx * bx + by * by);
        const c1 = py >= v[i][1], c2 = py < v[j][1], c3 = ex * wy > ey * wx;
        if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
      }
      return s * Math.sqrt(d);
    };
  }
  // Regular polygon or star. The rounding is subtracted from the radii, so
  // the result keeps roughly the same size.
  function ngon(n, rot, rounding, inner) {
    const pts = [];
    const steps = inner ? n * 2 : n;
    for (let i = 0; i < steps; i++) {
      const a = (rot - 90) * DEG + (TAU * i) / steps;
      const r = inner && i % 2 ? inner : 1;
      pts.push([Math.cos(a) * (r - rounding), Math.sin(a) * (r - rounding)]);
    }
    return round(polygonSDF(pts), rounding);
  }
  function segment(ax, ay, bx, by, r) {
    return (x, y) => {
      const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
      const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
      return len(pax - bax * h, pay - bay * h) - r;
    };
  }
  // Hull of two circles: r1 at the origin, r2 at distance h (pointing up).
  function unevenCapsule(r1, r2, h) {
    return (x, y) => {
      x = Math.abs(x); y = -y;
      const b = (r1 - r2) / h, a = Math.sqrt(1 - b * b);
      const k = -b * x + a * y;
      if (k < 0) return len(x, y) - r1;
      if (k > a * h) return len(x, y - h) - r2;
      return a * x + b * y - r1;
    };
  }
  function heartSDF() {
    const f = (x, y) => {
      x = Math.abs(x);
      if (y + x > 1) return len(x - 0.25, y - 0.75) - Math.SQRT2 / 4;
      const m = 0.5 * Math.max(x + y, 0);
      return Math.sqrt(Math.min((x) ** 2 + (y - 1) ** 2, (x - m) ** 2 + (y - m) ** 2)) * Math.sign(x - y);
    };
    return round((x, y) => f(x * 0.95, 0.42 - y * 0.95), 0.06);
  }

  /* ------------------------------------------------------------------ */
  /* Shapes                                                              */
  /* ------------------------------------------------------------------ */
  // eye: [x, y, scale] = where the eyes sit when the bot looks straight ahead.
  const SHAPE_DEFS = {
    // The 13 shapes in the "New Bot" picker, in picker order
    circle:   { label: 'Circle',   sdf: circle(0, 0, 1) },
    cloud:    { label: 'Cloud',    sdf: sunion(0.08, circle(-0.5, 0.12, 0.42), circle(-0.08, -0.26, 0.5), circle(0.44, -0.1, 0.45), circle(0.36, 0.36, 0.4), circle(-0.12, 0.36, 0.42), circle(0, 0, 0.5)) },
    diamond:  { label: 'Tilted square', sdf: rotate(ngon(4, 45, 0.32), 14) },
    sparkle:  { label: 'Sparkle',  sdf: ngon(4, 0, 0.22, 0.52), eye: [0, -0.02, 0.75] },
    clover:   { label: 'Clover',   sdf: sunion(0.18, circle(0, -0.5, 0.48), circle(0.5, 0, 0.48), circle(0, 0.5, 0.48), circle(-0.5, 0, 0.48), circle(0, 0, 0.5)) },
    pebble:   { label: 'Pebble',   sdf: rotate(unevenCapsule(0.66, 0.36, 0.5), -112), eye: [0.18, -0.08, 1] },
    flower:   { label: 'Flower',   sdf: sunion(0.05, circle(0, 0, 0.62), ...Array.from({ length: 8 }, (_, i) => circle(Math.cos(i * TAU / 8 + 0.2) * 0.64, Math.sin(i * TAU / 8 + 0.2) * 0.64, 0.33))) },
    drop:     { label: 'Drop',     sdf: sunion(0.75, circle(0.12, 0.14, 0.72), circle(-0.56, -0.62, 0.12)), eye: [0.18, -0.02, 1] },
    pill:     { label: 'Pill',     sdf: rotate(segment(-0.48, 0, 0.48, 0, 0.5), -16), eye: [0.18, -0.12, 0.95] },
    triangle: { label: 'Triangle', sdf: rotate(ngon(3, 90, 0.3), -8), eye: [0.02, -0.08, 0.85] },
    pentagon: { label: 'Pentagon', sdf: rotate(ngon(5, 0, 0.26), -10) },
    gear:     { label: 'Burst',    sdf: ngon(8, 0, 0.14, 0.74), eye: [0.08, -0.12, 0.9] },
    hexagon:  { label: 'Hexagon',  sdf: rotate(ngon(6, 0, 0.26), 8) },
    // Extras
    egg:      { label: 'Egg',      sdf: sunion(0.6, circle(0, 0.14, 0.8), circle(0, -0.3, 0.56)), eye: [0.14, -0.22, 1] },
    squircle: { label: 'Squircle', sdf: ngon(4, 45, 0.42) },
    octagon:  { label: 'Octagon',  sdf: ngon(8, 22.5, 0.2) },
    star:     { label: 'Star',     sdf: ngon(5, 0, 0.16, 0.55), eye: [0, 0.02, 0.78] },
    heart:    { label: 'Heart',    sdf: heartSDF(), eye: [0.04, -0.06, 0.9] },
    ghost:    { label: 'Ghost',    sdf: sunion(0.12, segment(0, -0.2, 0, 0.35, 0.72), circle(-0.5, 0.72, 0.24), circle(0, 0.74, 0.24), circle(0.5, 0.72, 0.24)), eye: [0.1, -0.3, 1] },
    blob:     { label: 'Blob',     sdf: sunion(0.5, circle(-0.3, 0.15, 0.65), circle(0.3, -0.1, 0.62), circle(0.15, 0.35, 0.5)) },
    shield:   { label: 'Shield',   sdf: round(polygonSDF([[-0.7, -0.68], [0.7, -0.68], [0.7, 0.1], [0, 0.72], [-0.7, 0.1]]), 0.26), eye: [0.1, -0.18, 1] },
    leaf:     { label: 'Leaf',     sdf: rotate((x, y) => Math.max(len(x - 0.55, y) - 1.05, len(x + 0.55, y) - 1.05), 35) },
  };
  // Internal shapes: the "!" bar
  const BANG_BAR = segment(0.14, -0.95, 0.0, 0.22, 0.19);

  function sampleSDF(f) {
    const pts = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const a = -Math.PI / 2 + (TAU * i) / N;
      const dx = Math.cos(a), dy = Math.sin(a);
      let t = 0;
      while (t < 3 && f(dx * t, dy * t) < 0) t += 0.02;
      let lo = Math.max(0, t - 0.02), hi = t;
      for (let k = 0; k < 14; k++) {
        const m = (lo + hi) / 2;
        if (f(dx * m, dy * m) < 0) lo = m; else hi = m;
      }
      pts[i * 2] = dx * hi; pts[i * 2 + 1] = dy * hi;
    }
    return pts;
  }
  function normalize(pts) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < N; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const s = 1 / Math.max((x1 - x0) / 2, (y1 - y0) / 2);
    for (let i = 0; i < N; i++) { pts[i * 2] = (pts[i * 2] - cx) * s; pts[i * 2 + 1] = (pts[i * 2 + 1] - cy) * s; }
    return pts;
  }
  const SHAPES = {};
  for (const [k, d] of Object.entries(SHAPE_DEFS)) {
    SHAPES[k] = { name: k, label: d.label, pts: normalize(sampleSDF(d.sdf)), eye: d.eye || [0.12, -0.16, 1] };
  }
  const BANG_PTS = sampleSDF(BANG_BAR);
  const DOT_PTS = sampleSDF(circle(0, 0, 1));

  function pathFromPoints(p, sx = 1, sy = 1, ox = 0, oy = 0) {
    // closed Catmull-Rom spline -> cubic Béziers
    const X = (i) => p[((i + N) % N) * 2] * sx + ox;
    const Y = (i) => p[((i + N) % N) * 2 + 1] * sy + oy;
    let d = `M${X(0).toFixed(3)} ${Y(0).toFixed(3)}`;
    for (let i = 0; i < N; i++) {
      const c1x = X(i) + (X(i + 1) - X(i - 1)) / 6, c1y = Y(i) + (Y(i + 1) - Y(i - 1)) / 6;
      const c2x = X(i + 1) - (X(i + 2) - X(i)) / 6, c2y = Y(i + 1) - (Y(i + 2) - Y(i)) / 6;
      d += `C${c1x.toFixed(3)} ${c1y.toFixed(3)} ${c2x.toFixed(3)} ${c2y.toFixed(3)} ${X(i + 1).toFixed(3)} ${Y(i + 1).toFixed(3)}`;
    }
    return d + 'Z';
  }
  function shapePath(name) { return pathFromPoints((SHAPES[name] || SHAPES.circle).pts); }

  /* ------------------------------------------------------------------ */
  /* Palette (the picker's 11 colours, then extras)                      */
  /* ------------------------------------------------------------------ */
  const COLORS = {
    black: '#111111', brown: '#8E5B34', red: '#FF263C', tangerine: '#FF6A00', orange: '#FF9800',
    green: '#00C972', teal: '#00B5A6', blue: '#1084FE', purple: '#9159FE', pink: '#FF2F9A', gray: '#7A7A7A',
    // extras
    yellow: '#FFC700', lime: '#7ED321', sky: '#2BB5F0', indigo: '#5E5CE6', coral: '#FF6B5E', mint: '#3DDCB0',
    lavender: '#B98CFF', navy: '#1F3A93', white: '#F4F4F4',
  };
  const TRAIL_COLORS = ['#FF4D6D', '#B14CFF', '#4D7CFF', '#3DDC97', '#FFB020', '#00C2FF', '#E8E25A', '#FF6BD6'];

  function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  }

  /* ------------------------------------------------------------------ */
  /* Springs                                                             */
  /* ------------------------------------------------------------------ */
  class Spring {
    // e (local change): how close to its target, in its own units, is too close to see.
    constructor(x, k = 170, d = 18, e = 1e-3) { this.x = x; this.v = 0; this.t = x; this.k = k; this.d = d; this.e = e; }
    step(dt) { const a = -this.k * (this.x - this.t) - this.d * this.v; this.v += a * dt; this.x += this.v * dt; }
    set(t) { this.t = t; return this; }
    snap(x) { this.x = this.t = x; this.v = 0; }
    kick(v) { this.v += v; }
    // Local change: at its target and slow enough to stop there.
    still() { return Math.abs(this.x - this.t) < this.e && Math.abs(this.v) < this.e * 20; }
  }
  // Springs that only move the eyes; the rest move the body or what is around it.
  const EYES = { lookX: 1, lookY: 1, ew: 1, eh: 1, erot: 1, edy: 1, egap: 1, eyeOp: 1, openL: 1, openR: 1, eyeScale: 1, eyeAX: 1, eyeAY: 1 };

  /* ------------------------------------------------------------------ */
  /* Expressions and states                                              */
  /* ------------------------------------------------------------------ */
  // w/h: eye size, rot: tilt in degrees, dy: vertical nudge, gap: eye spacing
  const EXPRESSIONS = {
    normal:    { w: 0.15, h: 0.40, rot: -20, dy: 0, gap: 0.36 },
    happy:     { w: 0.26, h: 0.10, rot: -12, dy: -0.04, gap: 0.40 },
    squint:    { w: 0.22, h: 0.07, rot: -8, dy: 0.02, gap: 0.38 },
    surprised: { w: 0.24, h: 0.48, rot: -10, dy: -0.02, gap: 0.42 },
    round:     { w: 0.24, h: 0.30, rot: -8, dy: 0.02, gap: 0.46 },
    sleepy:    { w: 0.24, h: 0.05, rot: 0, dy: 0.10, gap: 0.40 },
    sad:       { w: 0.15, h: 0.34, rot: 22, dy: 0.06, gap: 0.36 },
    focused:   { w: 0.15, h: 0.24, rot: -24, dy: 0, gap: 0.34 },
  };

  const STATES = ['idle', 'typing', 'working', 'done', 'alert', 'notify', 'sleeping', 'sad', 'listening'];
  const STATE_LABELS = {
    idle: 'Idle', typing: 'Waiting', working: 'Working', done: 'Response',
    alert: 'Needs approval', notify: 'Notification', sleeping: 'Sleeping', sad: 'Error', listening: 'Listening',
  };

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  /* ------------------------------------------------------------------ */
  /* Shared ticker                                                       */
  /* ------------------------------------------------------------------ */
  // Local change: upstream updates every bot on every frame, and dozens of
  // bots redrawing every 16ms kept the main thread about half busy while
  // nothing on the page moved. Each bot is updated only as often as what it is
  // doing needs: its pace, which _update sets as it finishes.
  //   REST    nothing in motion. Its timers are looked at, which costs next to
  //           nothing, and nothing is drawn.
  //   SLOW    asleep: slow breathing and drifting z's, ~10 a second.
  //   STEADY  eyes or body moving by itself, or at work the whole time: ~30 a second.
  //   LIVELY  the body moving because of the pointer or a change of state
  //           (see _hurry): every frame, up to ~90 a second.
  // All but LIVELY share the same frames, the beats. On this page a frame in
  // which any bot's geometry changed costs about half a millisecond of layout
  // however little changed, so bots each keeping their own time made more such
  // frames, and cost more, than all of them redrawing together.
  const REST = 0, SLOW = 1, STEADY = 2, LIVELY = 3;
  const live = new Set();
  let rafId = 0, beatAt = 0, beat = 0;
  function loop(now) {
    const onBeat = !beatAt || now - beatAt >= 30;
    if (onBeat) { beatAt = now; beat++; }
    for (const b of live) {
      if (!b._visible) continue;
      if (b._pace === LIVELY ? b._at && now - b._at < 11 : !onBeat || (b._pace === SLOW && beat % 3)) continue;
      const dt = b._at ? Math.min(0.12, (now - b._at) / 1000) : 0;
      b._at = now;
      b._update(dt, now / 1000);
    }
    rafId = live.size ? requestAnimationFrame(loop) : 0;
    if (!rafId) beatAt = 0;
  }
  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => { for (const e of entries) if (e.target.__grokbot) e.target.__grokbot._visible = e.isIntersecting; })
    : null;

  let uid = 0;
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  // Local change: write an attribute only when its value changed. A bot holds
  // most of its attributes steady most of the time, and every write, changed or
  // not, makes the browser lay the bot out again.
  const put = (node, name, value) => {
    const seen = node.__put || (node.__put = {});
    if (seen[name] === value) return;
    seen[name] = value;
    node.setAttribute(name, value);
  };

  /* ------------------------------------------------------------------ */
  /* GrokBot                                                             */
  /* ------------------------------------------------------------------ */
  class GrokBot {
    /**
     * @param {Element} host  Element the SVG is appended to.
     * @param {object} [o]
     *   shape, color, size (px), state, expression, eyeColor,
     *   followPointer (bool), autonomous (bool, idle blinking and glancing),
     *   extent (viewBox half-size, default 1.12), still (render once, no animation),
     *   eyeSize (multiplier on eye size, default 1)
     */
    constructor(host, o = {}) {
      this.id = ++uid;
      this.host = host;
      this.opts = Object.assign({ shape: 'circle', color: COLORS.black, size: 48, state: 'idle', autonomous: true, followPointer: false, extent: 1.12, eyeSize: 1 }, o);
      this._visible = true;
      this._time = 0;
      this._timers = [];
      this._particles = [];
      // Local change, see "Shared ticker": how often it is updated, whether the
      // outline is on its way to a new shape, and whether it must be drawn anew.
      this._pace = LIVELY;
      this._brisk = 0;
      this._morphing = false;
      this._redraw = true;
      this.baseShape = SHAPES[this.opts.shape] ? this.opts.shape : 'circle';
      this._shapeNow = this.baseShape;

      // outline points
      const src = SHAPES[this.baseShape].pts;
      this._p = Float32Array.from(src);
      this._v = new Float32Array(N * 2);
      this._t = Float32Array.from(src);
      this._morphK = 210; this._morphD = 15;

      // body transform
      this.s = {
        scale: new Spring(1, 200, 16), sx: new Spring(1, 300, 12), sy: new Spring(1, 300, 12),
        y: new Spring(0, 260, 14, 0.01), x: new Spring(0, 260, 16, 0.01), rot: new Spring(0, 140, 12, 0.05),
        lookX: new Spring(0.35, 120, 16, 0.01), lookY: new Spring(-0.35, 120, 16, 0.01),
        ew: new Spring(0.15, 260, 20), eh: new Spring(0.4, 300, 20), erot: new Spring(-20, 200, 18, 0.2), edy: new Spring(0, 200, 18), egap: new Spring(0.36, 200, 18),
        eyeOp: new Spring(1, 260, 24, 5e-3), openL: new Spring(1, 900, 40, 5e-3), openR: new Spring(1, 900, 40, 5e-3),
        eyeScale: new Spring(SHAPES[this.baseShape].eye[2], 200, 20), eyeAX: new Spring(SHAPES[this.baseShape].eye[0], 200, 20), eyeAY: new Spring(SHAPES[this.baseShape].eye[1], 200, 20),
        dots: new Spring(0, 220, 22, 5e-3), bangDot: new Spring(0, 260, 14, 5e-3), badge: new Spring(0, 320, 14, 5e-3), trails: new Spring(0, 60, 14, 0.01),
      };

      this._build();
      this._measure(this.opts.size);
      this.setColor(this.opts.color);
      this.setExpression('normal', true);
      this.setState(this.opts.state);
      if (this.opts.followPointer) this._bindPointer();

      this.svg.__grokbot = this;
      if (io) io.observe(this.svg);
      if (this.opts.still) { this._update(0, 0); return; }
      live.add(this);
      if (!rafId) rafId = requestAnimationFrame(loop);
    }

    /* ---------------- DOM ---------------- */
    _build() {
      const E = this.opts.extent;
      const svg = this.svg = el('svg', { viewBox: `${-E} ${-E} ${E * 2} ${E * 2}`, width: this.opts.size, height: this.opts.size, class: 'grokbot', role: 'img', 'aria-label': 'Grok Bot character' });
      svg.style.overflow = 'visible';
      svg.style.display = 'block';
      this.gBack = el('g', { 'stroke-linecap': 'round', fill: 'none' }, svg);
      this.gBody = el('g', {}, svg);
      this.body = el('path', {}, this.gBody);
      // eyes are clipped to the body so they slide off the edge cleanly while tumbling
      const clip = el('clipPath', { id: `grokbot-clip-${this.id}` }, el('defs', {}, svg));
      this.clipPath = el('path', {}, clip);
      this.gEyes = el('g', { 'clip-path': `url(#grokbot-clip-${this.id})` }, this.gBody);
      this.eyeL = el('rect', {}, this.gEyes);
      this.eyeR = el('rect', {}, this.gEyes);
      this.dotL = el('circle', { r: 0.2 }, svg);
      this.dotR = el('circle', { r: 0.2 }, svg);
      this.bangDot = el('circle', { r: 0 }, svg);
      this.gFront = el('g', { 'stroke-linecap': 'round', fill: 'none' }, svg);
      this.gParticles = el('g', {}, svg);
      this.badge = el('circle', { r: 0, fill: '#1E8BF0', stroke: '#fff', 'stroke-width': 0.07 }, svg);
      this._trailEls = [];
      for (let i = 0; i < 6; i++) {
        this._trailEls.push({
          back: el('path', { stroke: TRAIL_COLORS[i % TRAIL_COLORS.length], 'stroke-width': 0.075 }, this.gBack),
          front: el('path', { stroke: TRAIL_COLORS[i % TRAIL_COLORS.length], 'stroke-width': 0.075 }, this.gFront),
        });
      }
      this._newTrails();
      this.host.appendChild(svg);
    }

    _newTrails() {
      this._trails = this._trailEls.map((e, i) => {
        // random orbit plane
        const th = rand(0, TAU), ph = rand(0.35, 1.25);
        const n = [Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)];
        let u = [-n[1], n[0], 0]; const ul = len(u[0], u[1]) || 1; u = [u[0] / ul, u[1] / ul, 0];
        const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        return { e, u, v, R: rand(1.12, 1.38), phase: rand(0, TAU), speed: rand(3.2, 5.5) * (Math.random() < 0.3 ? -1 : 1), arc: rand(1.3, 2.6), prec: rand(-0.6, 0.6), w: rand(0.05, 0.09) };
      });
    }

    _bindPointer() {
      this._onMove = (ev) => {
        if (this.state === 'sleeping' || this.state === 'typing' || this.state === 'alert') return;
        const r = this.svg.getBoundingClientRect();
        const dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
        const d = Math.max(r.width * 0.8, len(dx, dy));
        this._pointer = { x: clamp((dx / d) * 1.1, -1, 1), y: clamp((dy / d) * 1.1, -1, 1), t: this._time };
      };
      window.addEventListener('pointermove', this._onMove, { passive: true });
    }

    /* ---------------- public API ---------------- */
    setColor(c) {
      this.color = COLORS[c] || c;
      this.body.setAttribute('fill', this.color);
      for (const n of [this.dotL, this.dotR, this.bangDot]) n.setAttribute('fill', this.color);
      const eye = this.opts.eyeColor || (luminance(this.color) > 0.82 ? '#1A1A1A' : '#FFFFFF');
      this.eyeL.setAttribute('fill', eye); this.eyeR.setAttribute('fill', eye);
      for (const p of this._particles) p.node.setAttribute('fill', this.color);
      return this;
    }

    setShape(name, { boing = true } = {}) {
      if (!SHAPES[name]) return this;
      this.baseShape = name;
      if (this.state !== 'working' && this.state !== 'alert' && this.state !== 'typing') this._morphTo(name, boing);
      return this;
    }

    setSize(px) { this.svg.setAttribute('width', px); this.svg.setAttribute('height', px); this._measure(px); this._redraw = true; return this; }

    // Local change: how many device pixels one unit of the viewBox takes on
    // screen, to tell motion too small to see. Unknown for a size that isn't
    // a number of pixels; then nothing counts as too small.
    _measure(px) {
      const size = parseFloat(px);
      const dense = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
      this._grain = size > 0 ? (size / (this.opts.extent * 2)) * dense : Infinity;
    }

    setExpression(name, instant) {
      const e = EXPRESSIONS[name] || EXPRESSIONS.normal;
      this.expression = name;
      const s = this.s;
      s.ew.set(e.w); s.eh.set(e.h); s.erot.set(e.rot); s.edy.set(e.dy); s.egap.set(e.gap);
      if (instant) { for (const k of ['ew', 'eh', 'erot', 'edy', 'egap']) s[k].snap(s[k].t); this._redraw = true; }
      return this;
    }

    look(x, y, hold = 1.5) { this._lookHold = this._time + hold; this.s.lookX.set(clamp(x, -1, 1)); this.s.lookY.set(clamp(y, -1, 1)); return this; }

    setState(state) {
      if (!STATES.includes(state)) state = 'idle';
      const prev = this.state;
      this.state = state;
      this._timers = [];
      this._redraw = true;
      this._hurry();
      this._lookHold = 0; // release any look held by the previous state
      const s = this.s;
      // reset (pending timers were dropped, so reopen eyes that a blink or wink left shut)
      s.openL.set(1); s.openR.set(1);
      s.dots.set(0); s.bangDot.set(0); s.trails.set(0); s.eyeOp.set(1); s.scale.set(1); s.rot.set(0); s.x.set(0);
      if (state !== 'notify') s.badge.set(0);
      this.setExpression('normal');

      if (prev === 'typing' && state !== 'typing') { s.scale.kick(4); this._squash(0.3); }
      if (prev === 'alert' && state !== 'alert') { s.scale.x = 0.6; }

      switch (state) {
        case 'idle':
          this._morphTo(this.baseShape, prev && prev !== 'idle');
          this.look(0.35, -0.35, 0.6);
          break;
        case 'typing':
          this._morphTo('circle', false, DOT_PTS);
          s.scale.set(0.2); s.eyeOp.set(0); s.dots.set(1);
          break;
        case 'working':
          this._newTrails();
          s.trails.set(1);
          this.setExpression('focused');
          this._workIdx = 0;
          this._morphTo(this.baseShape, true);
          this._every(1.5, () => {
            const cycle = ['egg', 'hexagon', 'triangle', 'circle', 'pentagon', 'drop', 'squircle', 'pill'];
            const next = cycle[this._workIdx++ % cycle.length];
            this._morphTo(next === this._shapeNow ? 'circle' : next, true);
            if (this._workIdx % 2) this.spin(Math.random() < 0.7 ? 1 : -1, { tilt: rand(-35, 35) });
            else s.rot.kick(rand(-120, 120));
          });
          break;
        case 'done':
          this._morphTo(this.baseShape, true);
          this.setExpression('happy');
          this.look(0.2, -0.5, 1.2);
          this.bounce(1.1);
          this._after(0.45, () => this.bounce(0.7));
          this._after(2.2, () => this.setExpression('normal'));
          break;
        case 'alert':
          this._morphTo(null, true, BANG_PTS);
          s.eyeOp.set(0); s.bangDot.set(1); s.scale.set(1);
          this._every(1.6, () => { s.rot.kick(rand(60, 120) * (Math.random() < 0.5 ? -1 : 1)); s.y.kick(-3); });
          break;
        case 'notify':
          this._morphTo(this.baseShape, true);
          this.setExpression('round');
          s.badge.set(1);
          this.look(-0.1, 0.1, 1);
          break;
        case 'sleeping':
          this._morphTo(this.baseShape, true);
          this.setExpression('sleepy');
          this.look(0, 0.3, 1e9);
          this._every(1.4, () => this._z());
          break;
        case 'sad':
          this._morphTo(this.baseShape, true);
          this.setExpression('sad');
          this.look(-0.2, 0.45, 1e9);
          this.shake();
          break;
        case 'listening':
          this._morphTo(this.baseShape, true);
          this.setExpression('surprised');
          this.look(0, -0.1, 1e9);
          break;
      }
      return this;
    }

    blink(double) {
      const s = this.s;
      s.openL.set(0.08); s.openR.set(0.08);
      this._after(0.09, () => { s.openL.set(1); s.openR.set(1); });
      if (double) this._after(0.24, () => this.blink(false));
      return this;
    }
    wink(side = 'R') {
      const sp = side === 'L' ? this.s.openL : this.s.openR;
      sp.set(0.08); this.s.rot.kick(side === 'L' ? -40 : 40);
      this._after(0.45, () => sp.set(1));
      return this;
    }
    bounce(power = 1) { this.s.y.kick(-6 * power); this._squash(-0.25 * power); this._after(0.18 / Math.max(power, 0.5), () => this._squash(0.22 * power)); return this; }
    shake() { let n = 0; const go = () => { this.s.x.kick(n % 2 ? 7 : -7); if (++n < 5) this._after(0.07, go); }; go(); return this; }
    surprise() {
      const prev = this.expression; this.setExpression('surprised'); this.s.scale.kick(3); this._squash(-0.2);
      this._after(0.9, () => this.setExpression(prev === 'surprised' ? 'normal' : prev));
      return this;
    }
    /**
     * 3D tumble, as in the official footage. The bot rolls head over heels around
     * a (slightly tilted) horizontal axis with its top coming toward the viewer.
     * The eyes slide down the face and hide while the back is showing, then come
     * back over the top. dir = 1 rolls forward, -1 rolls backward.
     */
    spin(dir = 1, { turns = 1, dur = 1.05, tilt = rand(-18, 18) } = {}) {
      const cur = this._tumble();
      this._spin = { start: this._time, dur: dur * turns, dir, turns, tilt, from: cur ? cur.phi % TAU : 0 };
      this.s.y.kick(-5); this._squash(-0.14);
      return this;
    }
    intro() {
      const s = this.s; s.scale.snap(0.05); s.scale.set(1); s.scale.kick(2);
      for (let i = 0; i < 6; i++) {
        const a = rand(0, TAU);
        this._particle(Math.cos(a) * 1.8, Math.sin(a) * 1.8, -Math.cos(a) * 3.5, -Math.sin(a) * 3.5, rand(0.06, 0.12), 0.45);
      }
      this.blink();
      return this;
    }
    spit() {
      const lx = this.s.lookX.x || 0.01, ly = this.s.lookY.x;
      const l = len(lx, ly) || 1, dx = lx / l, dy = ly / l;
      this._squash(0.15); this.s.x.kick(-dx * 2); this.s.y.kick(-dy * 2);
      this._particle(dx * 0.9, dy * 0.9, dx * 4.2, dy * 4.2, 0.14, 1.4, 4.5);
      return this;
    }
    morph(name) { this._hurry(); this._morphTo(name, true); return this; }
    // Local change: what the pointer or a change of state sets off is drawn on
    // every frame for the next two seconds. What a bot gets up to by itself
    // (a wink, a hop) keeps to the beat, or with a dozen of them playing around
    // some bot would nearly always be redrawing on every frame.
    _hurry() { this._brisk = this._time + 2; this._pace = LIVELY; }

    destroy() {
      live.delete(this);
      if (io) io.unobserve(this.svg);
      if (this._onMove) window.removeEventListener('pointermove', this._onMove);
      this.svg.remove();
    }

    /* ---------------- internals ---------------- */
    _after(t, fn) { this._timers.push({ at: this._time + t, fn }); }
    _every(t, fn) { const tick = () => { fn(); this._after(t, tick); }; this._after(t * 0.6, tick); }
    // Current tumble: phi = roll angle (radians), a = axis tilt (radians), p = progress 0..1
    _tumble() {
      const sp = this._spin;
      if (!sp) return null;
      const p = clamp((this._time - sp.start) / sp.dur, 0, 1);
      if (p >= 1) { this._spin = null; return null; }
      // ease in, roll, overshoot by ~20° and settle back
      const K = 0.35; // short ease-in, long ease-out (value and slope match at p = K)
      const io = p < K ? (p * p) / K : 1 - ((1 - p) * (1 - p)) / (1 - K);
      const e = io + 0.055 * Math.sin(Math.PI * clamp((p - 0.5) / 0.5, 0, 1));
      return { phi: sp.from * (1 - p) + TAU * sp.turns * sp.dir * e, a: sp.tilt * DEG, p, dir: sp.dir };
    }
    _squash(a) { this.s.sx.kick(a * 9); this.s.sy.kick(-a * 9); }

    _morphTo(name, boing, rawPts) {
      const src = rawPts || SHAPES[name].pts;
      this._t.set(src);
      this._morphing = true;
      if (name) {
        this._shapeNow = name;
        const e = SHAPES[name].eye;
        this.s.eyeAX.set(e[0]); this.s.eyeAY.set(e[1]); this.s.eyeScale.set(e[2]);
      }
      if (boing) this._squash(0.18);
    }

    _particle(x, y, vx, vy, r, life, drag = 2.2) {
      const node = el('circle', { r, fill: this.color }, this.gParticles);
      this._particles.push({ node, x, y, vx, vy, r, life, age: 0, drag });
    }
    _z() {
      const node = el('text', { 'font-size': 0.42, 'font-weight': 700, 'font-family': 'system-ui, sans-serif', fill: this.color }, this.gParticles);
      node.textContent = 'z';
      this._particles.push({ node, text: true, x: 0.55, y: -0.7, vx: rand(0.15, 0.4), vy: -0.55, r: 0.42, life: 2.2, age: 0, drag: 0 });
    }

    _autonomous(t) {
      if (!this.opts.autonomous) return;
      const st = this.state;
      if (st === 'typing' || st === 'alert') return;
      if (this._nextBlink === undefined) this._nextBlink = t + rand(0.5, 3);
      if (t > this._nextBlink && st !== 'sleeping') { this.blink(Math.random() < 0.2); this._nextBlink = t + rand(1.8, 5); }
      if (this._nextLook === undefined) this._nextLook = t + rand(1, 3);
      if (t > this._nextLook && t > (this._lookHold || 0)) {
        if (st === 'working') this.look(rand(-0.9, 0.9), rand(-0.9, 0.6), 0);
        else if (st === 'idle' || st === 'done' || st === 'notify') {
          const spots = [[0.35, -0.35], [0.35, -0.35], [0.6, -0.5], [-0.5, -0.3], [-0.2, 0.3], [0.1, 0.05], [0.7, 0.1]];
          const [x, y] = pick(spots); this.look(x + rand(-0.08, 0.08), y + rand(-0.08, 0.08), 0);
        }
        this._nextLook = t + (st === 'working' ? rand(0.35, 0.9) : rand(1.4, 4));
      }
      if (st === 'idle' && this.opts.mischief !== false) {
        if (this._nextTrick === undefined) this._nextTrick = t + rand(6, 16);
        if (t > this._nextTrick) {
          const r = Math.random();
          if (r < 0.3) this.spit(); else if (r < 0.55) this.bounce(0.6); else if (r < 0.75) this.wink(); else if (r < 0.88) this.surprise(); else this._morphTo(this.baseShape, true);
          this._nextTrick = t + rand(7, 18);
        }
      }
    }

    _update(dt, now) {
      this._time += dt;
      const t = this._time, s = this.s;

      // timers
      if (this._timers.length) {
        const due = this._timers.filter((x) => x.at <= t);
        if (due.length) { this._timers = this._timers.filter((x) => x.at > t); for (const d of due) d.fn(); }
      }
      this._autonomous(t);
      if (this._pointer && t - this._pointer.t < 2.5 && !(this._lookHold > t)) { s.lookX.set(this._pointer.x); s.lookY.set(this._pointer.y); }

      // Local change: see what is in motion before doing any work. With nothing
      // moving there is nothing to step and nothing to draw.
      const asleep = this.state === 'sleeping';
      // Breathing swells the body by 1.2% (3% asleep). At avatar sizes that is a
      // fraction of a pixel, and it alone kept every bot redrawing all the time,
      // so breathing that moves the outline under half a device pixel is left out.
      const breathes = (asleep ? 0.03 : 0.012) * this._grain >= 0.5;
      const shape = this._redraw || this._morphing;
      let body = shape || !!this._spin, eyes = this._redraw || !!this._spin;
      for (const key in s) if (!s[key].still()) { if (EYES[key]) eyes = true; else body = true; }
      // moving for as long as the state lasts, whatever the springs do
      const atWork = this.state === 'working' || this.state === 'typing';
      if (!body && !eyes && !atWork && !breathes && !this._particles.length && s.trails.x <= 0.01) { this._pace = REST; return; }
      this._redraw = false;

      // springs (fixed sub-steps)
      const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      const h = dt / steps;
      const P = this._p, V = this._v, T = this._t, K = this._morphK, D = this._morphD;
      for (let k = 0; k < steps; k++) {
        for (const key in s) s[key].step(h);
        if (this._morphing) for (let i = 0; i < N * 2; i++) { V[i] += (-K * (P[i] - T[i]) - D * V[i]) * h; P[i] += V[i] * h; }
      }
      // Local change: a spring never quite arrives by itself. Once it is too
      // close to its target to see, it stops there, and so does the outline.
      for (const key in s) { const sp = s[key]; if ((sp.x !== sp.t || sp.v !== 0) && sp.still()) { sp.x = sp.t; sp.v = 0; } }
      if (this._morphing) {
        let off = 0;
        for (let i = 0; i < N * 2; i++) off = Math.max(off, Math.abs(P[i] - T[i]), Math.abs(V[i]) / 20);
        if (off < 1e-3) { P.set(T); V.fill(0); this._morphing = false; }
      }

      // body
      const breathe = !breathes ? 1 : asleep ? 1 + Math.sin(t * 1.6) * 0.03 : 1 + Math.sin(t * 2.2 + this.id) * 0.012;
      let sc = Math.max(0, s.scale.x) * breathe;
      if (this.state === 'typing') sc *= 1 + 0.25 * Math.sin(t * 7.5 - 2.1);
      const ty = s.y.x * 0.08 + (1 - s.sy.x) * 0.6 * sc;
      const tb = this._tumble();
      // Tumble, as in the footage: the body stays a solid shape. It sways a little in-plane, compresses
      // slightly along the roll, and leans toward the viewer. The eyes carry the 3D (see below).
      let roll = '';
      if (tb) {
        const sn = Math.sin(tb.phi), ad = tb.a / DEG;
        sc *= 1 + 0.08 * Math.sin(Math.PI * tb.p);
        roll = ` rotate(${(tb.dir * 16 * sn).toFixed(2)}) rotate(${ad.toFixed(2)}) scale(1 ${(1 - 0.16 * Math.abs(sn)).toFixed(4)}) rotate(${(-ad).toFixed(2)})`;
      }
      const sx = sc * s.sx.x, sy = sc * s.sy.x;
      if (shape) {
        const d = pathFromPoints(this._p);
        put(this.body, 'd', d);
        put(this.clipPath, 'd', d);
      }
      put(this.gBody, 'transform', `translate(${(s.x.x * 0.06).toFixed(3)} ${ty.toFixed(3)}) rotate(${s.rot.x.toFixed(2)})${roll} scale(${sx.toFixed(4)} ${sy.toFixed(4)})`);

      // eyes
      const op = clamp(s.eyeOp.x, 0, 1);
      if (eyes) put(this.gEyes, 'opacity', op.toFixed(3));
      if (eyes && op > 0.01) {
        const es = s.eyeScale.x, ez = es * this.opts.eyeSize; // eyeSize grows the eyes, not how far they travel
        const lx = clamp(s.lookX.x, -1.2, 1.2), ly = clamp(s.lookY.x, -1.2, 1.2);
        const cx = s.eyeAX.x + lx * 0.34 * es, cy = s.eyeAY.x + ly * 0.34 * es + s.edy.x;
        const gap = s.egap.x * ez;
        const drawEye = (node, side, open) => {
          let ex = cx + side * gap / 2, ey = cy;
          const fore = clamp(1 - Math.max(0, len(ex, ey) - 0.38) * 1.1, 0.45, 1); // foreshortening near the rim
          const w = Math.max(0.01, s.ew.x * ez * fore);
          const hh = Math.max(0.012, s.eh.x * ez * clamp(open, 0, 1.2));
          const r = Math.min(w, hh) / 2;
          let pre = '', vis = 1;
          if (tb) {
            // The eyes ride a sphere under the face: over the top as slits, swelling as they pass the
            // front, flattening at the bottom, hidden while the back is showing.
            const ca = Math.cos(tb.a), sa = Math.sin(tb.a), cp = Math.cos(tb.phi), sp = Math.sin(tb.phi);
            const z = Math.sqrt(Math.max(0.04, 1 - ex * ex - ey * ey));
            const u = ex * ca + ey * sa, v = -ex * sa + ey * ca;
            const v2 = v * cp + z * sp, z2 = -v * sp + z * cp;
            const nl = Math.hypot(v, z) || 1, nz0 = z / nl, nz = (-v * sp + z * cp) / nl; // facing, before and after
            const face = nz / Math.max(nz0, 0.2);                 // squash as it turns edge-on
            // as in the footage, the eyes balloon to ~2x on the way down, then flatten out at the bottom
            const persp = 1 + 0.95 * clamp(Math.sin(tb.phi * tb.dir) * 1.6, 0, 1) * clamp(nz * 2.2, 0, 1);
            vis = clamp(nz * 5, 0, 1);                             // hidden on the back
            ex = u * ca - v2 * sa; ey = u * sa + v2 * ca;
            pre = `rotate(${(tb.a / DEG).toFixed(2)}) scale(${persp.toFixed(3)} ${(persp * clamp(face, 0.04, 1.3)).toFixed(3)}) rotate(${(-tb.a / DEG).toFixed(2)}) `;
          }
          put(node, 'opacity', vis.toFixed(3));
          put(node, 'x', (-w / 2).toFixed(4)); put(node, 'y', (-hh / 2).toFixed(4));
          put(node, 'width', w.toFixed(4)); put(node, 'height', hh.toFixed(4));
          put(node, 'rx', r.toFixed(4)); put(node, 'ry', r.toFixed(4));
          put(node, 'transform', `translate(${ex.toFixed(4)} ${ey.toFixed(4)}) ${pre}rotate(${(s.erot.x + lx * 6).toFixed(2)})`);
        };
        drawEye(this.eyeL, -1, s.openL.x);
        drawEye(this.eyeR, 1, s.openR.x);
      }

      // typing dots
      const dots = clamp(s.dots.x, 0, 1.2);
      for (const [node, side, ph] of [[this.dotL, -1, 0], [this.dotR, 1, -4.2]]) {
        if (dots < 0.01) { put(node, 'r', 0); continue; }
        const wave = 0.5 + 0.5 * Math.sin(t * 7.5 + ph);
        put(node, 'cx', (side * 0.6 * dots).toFixed(3));
        put(node, 'cy', (-wave * 0.06).toFixed(3));
        put(node, 'r', (0.18 * Math.min(1, dots) * (0.85 + 0.25 * wave)).toFixed(3));
        put(node, 'opacity', (0.35 + 0.65 * wave).toFixed(3));
      }

      // the dot of the "!" (placed only while it shows)
      const bd = Math.max(0, s.bangDot.x);
      put(this.bangDot, 'r', (0.19 * bd).toFixed(3));
      if (bd > 0) {
        put(this.bangDot, 'cx', (-0.03 + s.x.x * 0.03).toFixed(3));
        put(this.bangDot, 'cy', (0.62 + 0.1 * bd + s.y.x * 0.03).toFixed(3));
      }

      // notification badge (placed only while it shows)
      const bg = Math.max(0, s.badge.x);
      put(this.badge, 'r', (0.2 * bg).toFixed(3));
      if (bg > 0) {
        put(this.badge, 'cx', (0.72 * sc).toFixed(3));
        put(this.badge, 'cy', (-0.72 * sc + ty).toFixed(3));
      }

      // orbit trails
      const tr = clamp(s.trails.x, 0, 1);
      if (tr > 0.01) {
        for (const o of this._trails) {
          o.phase += o.speed * dt;
          const seg = o.arc * tr, M = 22;
          let back = '', front = '', prevFront = null;
          const pa = o.prec * t;
          const cp = Math.cos(pa), sp = Math.sin(pa);
          for (let i = 0; i <= M; i++) {
            const a = o.phase - seg + (seg * i) / M;
            const ca = Math.cos(a), sa = Math.sin(a);
            let X = (o.u[0] * ca + o.v[0] * sa) * o.R, Y = (o.u[1] * ca + o.v[1] * sa) * o.R, Z = (o.u[2] * ca + o.v[2] * sa) * o.R;
            const X2 = X * cp + Z * sp; Z = -X * sp + Z * cp; X = X2; // slow precession around the vertical axis
            const isFront = Z > 0;
            const cmd = (prevFront === isFront ? 'L' : 'M') + (X * sc).toFixed(3) + ' ' + (Y * sc + ty).toFixed(3);
            if (isFront) front += cmd; else back += cmd;
            prevFront = isFront;
          }
          o.e.back.setAttribute('d', back); o.e.front.setAttribute('d', front);
          o.e.back.setAttribute('stroke-width', (o.w * tr).toFixed(3)); o.e.front.setAttribute('stroke-width', (o.w * tr).toFixed(3));
        }
      } else if (this._trailsDrawn !== false) {
        for (const o of this._trails) { o.e.back.setAttribute('d', ''); o.e.front.setAttribute('d', ''); }
      }
      this._trailsDrawn = tr > 0.01;

      // particles
      for (let i = this._particles.length - 1; i >= 0; i--) {
        const p = this._particles[i];
        p.age += dt;
        const k = Math.exp(-p.drag * dt);
        p.vx *= k; p.vy *= k; p.x += p.vx * dt; p.y += p.vy * dt;
        const life = p.age / p.life;
        if (life >= 1) { p.node.remove(); this._particles.splice(i, 1); continue; }
        if (p.text) {
          p.node.setAttribute('x', p.x.toFixed(3)); p.node.setAttribute('y', p.y.toFixed(3));
          p.node.setAttribute('opacity', (Math.sin(life * Math.PI)).toFixed(3));
          p.node.setAttribute('font-size', (0.25 + life * 0.3).toFixed(3));
        } else {
          p.node.setAttribute('cx', p.x.toFixed(3)); p.node.setAttribute('cy', p.y.toFixed(3));
          p.node.setAttribute('r', (p.r * (life < 0.8 ? 1 : (1 - life) / 0.2)).toFixed(3));
        }
      }

      // Local change: how soon it needs updating again (see "Shared ticker").
      body = this._morphing || !!this._spin; eyes = false;
      for (const key in s) if (!s[key].still()) { if (EYES[key]) eyes = true; else body = true; }
      let flying = false; // a spat dot flies fast; a z only drifts
      for (const p of this._particles) if (!p.text) flying = true;
      const moving = body || flying;
      this._pace = atWork ? STEADY : moving && t < this._brisk ? LIVELY : moving || eyes ? STEADY : this._particles.length || breathes ? SLOW : REST;
    }
  }

  GrokBot.SHAPES = SHAPES;
  GrokBot.SHAPE_NAMES = Object.keys(SHAPES);
  GrokBot.PICKER_SHAPES = ['circle', 'cloud', 'diamond', 'sparkle', 'clover', 'pebble', 'flower', 'drop', 'pill', 'triangle', 'pentagon', 'gear', 'hexagon'];
  GrokBot.COLORS = COLORS;
  GrokBot.PICKER_COLORS = ['black', 'brown', 'red', 'tangerine', 'orange', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];
  GrokBot.STATES = STATES;
  GrokBot.STATE_LABELS = STATE_LABELS;
  GrokBot.EXPRESSIONS = Object.keys(EXPRESSIONS);
  GrokBot.shapePath = shapePath;

  /** Static SVG markup for a bot (no animation), handy for favicons and exports. */
  GrokBot.toSVG = function (shape = 'circle', color = 'black', size = 64) {
    const c = COLORS[color] || color;
    const sh = SHAPES[shape] || SHAPES.circle;
    const eye = luminance(c) > 0.82 ? '#1A1A1A' : '#FFFFFF';
    const [ax, ay, es] = sh.eye;
    const cx = ax + 0.35 * 0.34 * es, cy = ay - 0.35 * 0.34 * es, gap = 0.36 * es;
    const w = 0.15 * es, h = 0.4 * es;
    const eyeRect = (x) => `<rect x="${(-w / 2).toFixed(3)}" y="${(-h / 2).toFixed(3)}" width="${w.toFixed(3)}" height="${h.toFixed(3)}" rx="${(w / 2).toFixed(3)}" fill="${eye}" transform="translate(${x.toFixed(3)} ${cy.toFixed(3)}) rotate(-18)"/>`;
    return `<svg xmlns="${NS}" viewBox="-1.12 -1.12 2.24 2.24" width="${size}" height="${size}"><path d="${pathFromPoints(sh.pts)}" fill="${c}"/>${eyeRect(cx - gap / 2)}${eyeRect(cx + gap / 2)}</svg>`;
  };

  return GrokBot;
});
