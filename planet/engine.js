/* engine.js - math, WebGL program wrapper, and the Planet renderer */
var m4 = {
  mul: function (a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++)
      for (var r = 0; r < 4; r++) {
        var s = 0;
        for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    return o;
  },
  persp: function (fov, asp, n, f) {
    var t = 1 / Math.tan(fov / 2);
    var o = new Float32Array(16);
    o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = (2 * f * n) / (n - f);
    return o;
  },
  look: function (e, c, up) {
    var z = [e[0] - c[0], e[1] - c[1], e[2] - c[2]];
    var l = Math.hypot(z[0], z[1], z[2]); z = [z[0] / l, z[1] / l, z[2] / l];
    var x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
    l = Math.hypot(x[0], x[1], x[2]) || 1; x = [x[0] / l, x[1] / l, x[2] / l];
    var y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    var o = new Float32Array(16);
    o[0] = x[0]; o[1] = y[0]; o[2] = z[0];
    o[4] = x[1]; o[5] = y[1]; o[6] = z[1];
    o[8] = x[2]; o[9] = y[2]; o[10] = z[2];
    o[12] = -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2]);
    o[13] = -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2]);
    o[14] = -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2]);
    o[15] = 1;
    return o;
  },
};

/* =================== params =================== */
/* Single source of truth: every tunable parameter's metadata (label, default,
   min/max/step, formatting) plus the default value of every other parameter.
   `defaultParams()` is derived from this so there is exactly one definition. */
var PARAMS = {
  // tunable (have min/max/step) -> become sliders
  dt:        { label: 'Timestep dt',          default: 300,   min: 120, max: 1800, step: 60,   fmt: function (v) { return v + ' s'; } },
  substeps:  { label: 'Substeps / frame',     default: 2,     min: 1,   max: 8,    step: 1 },
  omega:     { label: 'Rotation Ω',           default: 7.292e-5, min: 0, max: 3.6e-4, step: 1e-6, fmt: function (v) { return (v / 7.292e-5).toFixed(2) + '× Earth'; } },
  solar:     { label: 'Solar constant',       default: 1361,  min: 800, max: 2000, step: 10,   fmt: function (v) { return v + ' W/m²'; } },
  greenhouse:{ label: 'Greenhouse',           default: 0.55,  min: 0,   max: 1,    step: 0.01 },
  nuVelAir:  { label: 'Air viscosity ν',      default: 1.6e5, min: 0,   max: 6e5,  step: 1e4,  fmt: function (v) { return v.toExponential(1); } },
  nuTAir:    { label: 'Air heat diffusion',   default: 1.1e5, min: 0,   max: 6e5,  step: 1e4,  fmt: function (v) { return v.toExponential(1); } },
  fricAirLow:{ label: 'Surface friction',     default: 1.6e-5, min: 0, max: 8e-5, step: 1e-6, fmt: function (v) { return v.toExponential(1); } },
  conv:      { label: 'Convection gain',      default: 6e-6,  min: 0,   max: 3e-5, step: 5e-7, fmt: function (v) { return v.toExponential(1); } },
  kRad:      { label: 'Radiative exchange',   default: 2.5,   min: 0,   max: 8,    step: 0.1 },
  lapse:     { label: 'Reference lapse ΔT',   default: 45,    min: 20,  max: 70,   step: 1,    fmt: function (v) { return v + ' K'; } },
  evap:      { label: 'Evaporation k',        default: 0.005, min: 0,   max: 0.02, step: 0.0005, fmt: function (v) { return v.toFixed(4); } },
  kSurf:     { label: 'Sensible heat k',      default: 22,    min: 0,   max: 60,   step: 1,    fmt: function (v) { return v + ' W/m²K'; } },
  windStress:{ label: 'Wind stress',          default: 6e-8,  min: 0,   max: 3e-7, step: 5e-9, fmt: function (v) { return v.toExponential(1); } },
  thermo:    { label: 'Thermohaline mixing',  default: 2e-7,  min: 0,   max: 2e-6, step: 2e-8, fmt: function (v) { return v.toExponential(1); } },
  nuVelOcean:{ label: 'Ocean viscosity',      default: 6e3,   min: 0,   max: 4e4,  step: 1e3,  fmt: function (v) { return v.toExponential(1); } },
  cloudK:    { label: 'Cloud sensitivity',    default: 1.7,   min: 0,   max: 4,    step: 0.05 },
  noise:     { label: 'Symmetry-break noise', default: 0.02,  min: 0,   max: 0.2,  step: 0.005 },
  // non-tunable (default only; UI handled by checkboxes / mode / equirect buttons)
  running:        { default: true },
  nuTOcean:       { default: 4e3 },
  fricAirHigh:    { default: 2.5e-6 },
  fricOceanTop:   { default: 1.5e-6 },
  fricOceanDeep:  { default: 6e-7 },
  rainK:          { default: 2200 },
  dayNight:       { default: 1 },
  mode:           { default: 0 },
  showClouds:     { default: true },
  showParticles:  { default: true },
  particleOcean:  { default: 0 },
  showLand:       { default: 1 },
  nightShading:   { default: 1 },
  pointSize:      { default: 2.2 },
  relief:         { default: 0.004 },
  equirect:       { default: 0 },
};

function defaultParams() {
  var o = {};
  Object.keys(PARAMS).forEach(function (k) { o[k] = PARAMS[k].default; });
  return o;
}

/* Effective slider bounds for a key: per-instance override (from a preset)
   merged over the static PARAMS schema. */
function boundsOf(p, key) {
  var s = PARAMS[key];
  var o = p && p.bounds && p.bounds[key];
  return {
    min: o && o.min !== undefined ? o.min : s.min,
    max: o && o.max !== undefined ? o.max : s.max,
    step: o && o.step !== undefined ? o.step : s.step,
  };
}
function setBound(p, key, part) {
  if (!p.bounds) p.bounds = {};
  var cur = p.bounds[key] || {};
  if (part.min !== undefined) cur.min = part.min;
  if (part.max !== undefined) cur.max = part.max;
  if (part.step !== undefined) cur.step = part.step;
  p.bounds[key] = cur;
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function Prog(gl, vs, fs, name) {
  this.gl = gl;
  this.name = name;
  this.loc = new Map();
  this.unit = 0;
  var p = gl.createProgram();
  gl.attachShader(p, this._sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, this._sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    console.error(name + ' link: ' + gl.getProgramInfoLog(p));
  this.prog = p;
}
Prog.prototype._sh = function (type, src) {
  var gl = this.gl;
  var s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    var log = gl.getShaderInfoLog(s) || '';
    console.error(this.name + ' compile: ' + log);
    var m = /:(\d+):/.exec(log);
    if (m) console.error(src.split('\n').slice(Math.max(0, +m[1] - 4), +m[1] + 3).join('\n'));
  }
  return s;
};
Prog.prototype.use = function () {
  this.gl.useProgram(this.prog);
  this.unit = 0;
  return this;
};
Prog.prototype._u = function (n) {
  if (!this.loc.has(n)) this.loc.set(n, this.gl.getUniformLocation(this.prog, n));
  return this.loc.get(n);
};
Prog.prototype.f = function (n, v) { this.gl.uniform1f(this._u(n), v); return this; };
Prog.prototype.i = function (n, v) { this.gl.uniform1i(this._u(n), v); return this; };
Prog.prototype.iv2 = function (n, a, b) { this.gl.uniform2i(this._u(n), a, b); return this; };
Prog.prototype.v3 = function (n, a, b, c) { this.gl.uniform3f(this._u(n), a, b, c); return this; };
Prog.prototype.m4 = function (n, m) { this.gl.uniformMatrix4fv(this._u(n), false, m); return this; };
Prog.prototype.tex = function (n, t) {
  var gl = this.gl;
  var l = this._u(n);
  if (l === null) return this;
  gl.activeTexture(gl.TEXTURE0 + this.unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.uniform1i(l, this.unit);
  this.unit++;
  return this;
};

/* =================== Planet =================== */
function Planet(canvas, level) {
  var gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  this.gl = gl;
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('EXT_color_buffer_float is required (float render targets).');
  }
  gl.getExtension('OES_texture_float_linear');
  this.canvas = canvas;
  this.params = defaultParams();
  this.bounds = {}; // per-instance slider-bound overrides (from presets); see boundsOf/setBound
  this.grid = null;
  this.simTime = 0;
  this.onStats = null;

  this.A = []; this.B = [];
  this.texCellA = null; this.texCellB = null;
  this.texNbrA = null; this.texNbrB = null;
  this.texLookup = null;
  this.partTex = []; this.partIdx = 0;
  this.PW = 160; this.PH = 160;

  this.fbo = {};
  this.prog = {};
  this.vaoGlobe = null; this.vaoEmpty = null; this.ibo = null;
  this.raf = 0;
  this.frames = 0; this.lastFps = performance.now(); this.fps = 60;
  this.cam = { theta: 0.6, phi: 0.25, dist: 3.0 };
  this.drag = false; this.lx = 0; this.ly = 0;
  this.disposed = false;

  var self = this;
  this._onDown = function (e) {
    self.drag = true; self.lx = e.clientX; self.ly = e.clientY;
    if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
  };
  this._onUp = function () { self.drag = false; };
  this._onMove = function (e) {
    if (!self.drag) return;
    self.cam.theta -= (e.clientX - self.lx) * 0.005;
    self.cam.phi = Math.max(-1.5, Math.min(1.5, self.cam.phi + (e.clientY - self.ly) * 0.005));
    self.lx = e.clientX; self.ly = e.clientY;
  };
  this._onWheel = function (e) {
    e.preventDefault();
    self.cam.dist = Math.max(1.15, Math.min(9, self.cam.dist * (1 + Math.sign(e.deltaY) * 0.09)));
  };
  this._loop = function () { self.loop(); };

  this.compile();
  this.build(level);
  this.bindInput();
  this.loop();
}

Planet.prototype.mkTex = function (w, h, data, comps, linear) {
  if (comps === undefined) comps = 4;
  if (linear === undefined) linear = false;
  var gl = this.gl;
  var t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  var internal = comps === 1 ? gl.R32F : gl.RGBA32F;
  var fmt = comps === 1 ? gl.RED : gl.RGBA;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, gl.FLOAT, data);
  var f = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
};
Planet.prototype.mkFbo = function (texs) {
  var gl = this.gl;
  var f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  texs.forEach(function (t, i) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
  });
  gl.drawBuffers(texs.map(function (_, i) { return gl.COLOR_ATTACHMENT0 + i; }));
  var st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) console.error('FBO incomplete', st.toString(16));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return f;
};
Planet.prototype.compile = function () {
  var gl = this.gl;
  this.prog.ocean = new Prog(gl, QUAD_VS, OCEAN_FS, 'ocean');
  this.prog.air = new Prog(gl, QUAD_VS, AIR_FS, 'air');
  this.prog.cplO = new Prog(gl, QUAD_VS, COUPLE_FS('ocean'), 'coupleOcean');
  this.prog.cplA = new Prog(gl, QUAD_VS, COUPLE_FS('air'), 'coupleAir');
  this.prog.init = new Prog(gl, QUAD_VS, INIT_FS, 'init');
  this.prog.init2 = new Prog(gl, QUAD_VS, INIT2_FS, 'init2');
  this.prog.part = new Prog(gl, QUAD_VS, PART_FS, 'part');
  this.prog.points = new Prog(gl, PART_VS, PART_PS, 'points');
  this.prog.globe = new Prog(gl, GLOBE_VS, GLOBE_FS, 'globe');
  this.prog.cloud = new Prog(gl, CLOUD_VS, CLOUD_FS, 'cloud');
  this.prog.equi = new Prog(gl, EQUI_VS, EQUI_FS, 'equi');
  this.prog.equiCloud = new Prog(gl, EQUI_VS, EQUI_CLOUD_FS, 'equiCloud');
};

Planet.prototype.build = function (level) {
  var gl = this.gl;
  this.destroyGrid();
  var g = new Grid(level).build();
  this.grid = g;
  var W = g.W, H = g.H;

  this.texCellA = this.mkTex(W, H, g.cellA);
  this.texCellB = this.mkTex(W, H, g.cellB);
  this.texNbrA = this.mkTex(W, H * 6, g.nbrA);
  this.texNbrB = this.mkTex(W, H * 6, g.nbrB);
  this.texLookup = this.mkTex(g.lookupW, g.lookupH, g.lookup, 1);

  this.A = []; this.B = [];
  for (var i = 0; i < 6; i++) {
    this.A.push(this.mkTex(W, H, null));
    this.B.push(this.mkTex(W, H, null));
  }
  this.fbo.dynO = this.mkFbo([this.B[0], this.B[1]]);
  this.fbo.dynA = this.mkFbo([this.B[2], this.B[3], this.B[4], this.B[5]]);
  this.fbo.cplO = this.mkFbo([this.A[0], this.A[1]]);
  this.fbo.cplA = this.mkFbo([this.A[2], this.A[3], this.A[4], this.A[5]]);
  this.fbo.init = this.mkFbo([this.A[0], this.A[1], this.A[2], this.A[3]]);
  this.fbo.init2 = this.mkFbo([this.A[4], this.A[5]]);

  var pdata = new Float32Array(this.PW * this.PH * 4);
  for (var j = 0; j < this.PW * this.PH; j++) {
    var z = Math.random() * 2 - 1, a = Math.random() * 6.2831853, r = Math.sqrt(1 - z * z);
    pdata[j * 4] = r * Math.cos(a); pdata[j * 4 + 1] = z; pdata[j * 4 + 2] = r * Math.sin(a);
    pdata[j * 4 + 3] = Math.random();
  }
  this.partTex = [this.mkTex(this.PW, this.PH, pdata), this.mkTex(this.PW, this.PH, pdata)];
  this.fbo.p0 = this.mkFbo([this.partTex[0]]);
  this.fbo.p1 = this.mkFbo([this.partTex[1]]);

  this.ibo = gl.createBuffer();
  this.vaoGlobe = gl.createVertexArray();
  gl.bindVertexArray(this.vaoGlobe);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  this.vaoEmpty = gl.createVertexArray();

  this.reset();
};

Planet.prototype.destroyGrid = function () {
  var gl = this.gl;
  var all = this.A.concat(this.B, this.partTex, [this.texCellA, this.texCellB, this.texNbrA, this.texNbrB, this.texLookup]);
  all.forEach(function (t) { if (t) gl.deleteTexture(t); });
  Object.keys(this.fbo).forEach(function (k) { gl.deleteFramebuffer(this.fbo[k]); }, this);
  this.fbo = {};
  if (this.ibo) gl.deleteBuffer(this.ibo);
  if (this.vaoGlobe) gl.deleteVertexArray(this.vaoGlobe);
  if (this.vaoEmpty) gl.deleteVertexArray(this.vaoEmpty);
  this.A = []; this.B = []; this.partTex = [];
};

Planet.prototype.gridUniforms = function (p) {
  p.iv2('uDim', this.grid.W, this.grid.H).i('uCount', this.grid.V)
    .tex('uCellA', this.texCellA).tex('uCellB', this.texCellB)
    .tex('uNbrA', this.texNbrA).tex('uNbrB', this.texNbrB);
};
Planet.prototype.fullscreen = function (fboName, w, h) {
  var gl = this.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[fboName]);
  gl.viewport(0, 0, w, h);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(this.vaoEmpty);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
};

Planet.prototype.reset = function () {
  var W = this.grid.W, H = this.grid.H;
  this.simTime = 0;
  var p = this.prog.init.use();
  this.gridUniforms(p); p.f('uSeed', Math.random() * 1000);
  this.fullscreen('init', W, H);
  var p2 = this.prog.init2.use();
  this.gridUniforms(p2); p2.f('uSeed', Math.random() * 1000);
  this.fullscreen('init2', W, H);
};

Planet.prototype.couple = function () {
  var W = this.grid.W, H = this.grid.H;
  var P = this.params;
  var src = this.B;
  var sun = this.sunDir();
  var self = this;
  [['cplO', 'cplO'], ['cplA', 'cplA']].forEach(function (pair) {
    var pr = self.prog[pair[1]].use();
    self.gridUniforms(pr);
    pr.tex('uTop', src[0]).tex('uDeep', src[1]).tex('uLoA', src[2])
      .tex('uLoB', src[3]).tex('uHiA', src[4]).tex('uHiB', src[5]);
    pr.f('uDt', P.dt).f('uTime', self.simTime)
      .v3('uSun', sun[0], sun[1], sun[2])
      .f('uSolar', P.solar).f('uDayNight', P.dayNight).f('uSeasonDecl', self.decl())
      .f('uKsurf', P.kSurf).f('uEvap', P.evap).f('uWindStress', P.windStress)
      .f('uConv', P.conv).f('uKrad', P.kRad).f('uLapse', P.lapse)
      .f('uThermo', P.thermo).f('uCloudK', P.cloudK).f('uRainK', P.rainK)
      .f('uNoise', P.noise).f('uGreenhouse', P.greenhouse);
    self.fullscreen(pair[0], W, H);
  });
};

Planet.prototype.decl = function () {
  return 0.4084 * Math.sin((this.simTime / (365 * 86400)) * 6.2831853);
};
Planet.prototype.sunDir = function () {
  var d = this.decl();
  
  // calculate  Sun's longitude with planet's angular velocity (omega).
  // If omega = 0, the planet is tidally locked.
  var lon = this.params.omega * this.simTime; 
  
  return [Math.cos(d) * Math.cos(lon), Math.sin(d), Math.cos(d) * Math.sin(lon)];
};

Planet.prototype.step = function () {
  var W = this.grid.W, H = this.grid.H;
  var P = this.params;

  var po = this.prog.ocean.use();
  this.gridUniforms(po);
  po.tex('uTop', this.A[0]).tex('uDeep', this.A[1])
    .f('uDt', P.dt).f('uOmega', P.omega)
    .f('uNuVel', P.nuVelOcean).f('uNuT', P.nuTOcean)
    .f('uFricTop', P.fricOceanTop).f('uFricDeep', P.fricOceanDeep)
    .f('uAlphaT', 1.7e-4).f('uBetaS', 7.8e-4)
    .f('uPkTop', 9.81 * 200 * 1027).f('uPkDeep', 9.81 * 800 * 1027);
  this.fullscreen('dynO', W, H);

  var pa = this.prog.air.use();
  this.gridUniforms(pa);
  pa.tex('uLoA', this.A[2]).tex('uLoB', this.A[3]).tex('uHiA', this.A[4]).tex('uHiB', this.A[5])
    .f('uDt', P.dt).f('uOmega', P.omega)
    .f('uNuVel', P.nuVelAir).f('uNuT', P.nuTAir)
    .f('uFricLo', P.fricAirLow).f('uFricHi', P.fricAirHigh)
    .f('uRhoLo', 1.1).f('uRhoHi', 0.55);
  this.fullscreen('dynA', W, H);

  this.couple();
  this.simTime += P.dt;
};

Planet.prototype.stepParticles = function (dt) {
  var gl = this.gl;
  var src = this.partTex[this.partIdx];
  var dstFbo = this.partIdx === 0 ? 'p1' : 'p0';
  var p = this.prog.part.use();
  this.gridUniforms(p);
  p.tex('uPart', src).tex('uLookup', this.texLookup)
    .tex('uLoA', this.A[2]).tex('uTop', this.A[0])
    .iv2('uPDim', this.PW, this.PH)
    .f('uDt', dt).f('uLife', 60 * 3600).f('uRadius', PLANET_R)
    .f('uSeed', Math.random() * 1000).f('uOcean', this.params.particleOcean);
  this.fullscreen(dstFbo, this.PW, this.PH);
  this.partIdx = 1 - this.partIdx;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
};

Planet.prototype.render = function () {
  var gl = this.gl;
  var P = this.params;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
  var h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
  if (this.canvas.width !== w || this.canvas.height !== h) {
    this.canvas.width = w; this.canvas.height = h;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0.015, 0.02, 0.045, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);

  var equirect = P.equirect > 0.5;
  var sun = this.sunDir();

  if (equirect) {
    this.renderEquirect(w, h, sun);
    gl.bindVertexArray(null);
    return;
  }

  var c = this.cam;
  var eye = [
    c.dist * Math.cos(c.phi) * Math.sin(c.theta),
    c.dist * Math.sin(c.phi),
    c.dist * Math.cos(c.phi) * Math.cos(c.theta),
  ];
  var proj = m4.persp(0.9, w / h, 0.05, 40);
  var view = m4.look(eye, [0, 0, 0], [0, 1, 0]);
  var mvp = m4.mul(proj, view);

  var g = this.prog.globe.use();
  this.gridUniforms(g);
  g.tex('uTop', this.A[0]).tex('uDeep', this.A[1]).tex('uLoA', this.A[2])
    .tex('uLoB', this.A[3]).tex('uHiA', this.A[4]).tex('uHiB', this.A[5])
    .m4('uMVP', mvp).i('uMode', P.mode)
    .v3('uSun', sun[0], sun[1], sun[2]).v3('uEye', eye[0], eye[1], eye[2])
    .f('uShowLand', P.showLand).f('uNight', P.nightShading).f('uRelief', P.relief);
  gl.bindVertexArray(this.vaoGlobe);
  gl.drawElements(gl.TRIANGLES, this.grid.indices.length, gl.UNSIGNED_INT, 0);

  if (P.showClouds) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    var cl = this.prog.cloud.use();
    this.gridUniforms(cl);
    cl.tex('uLoB', this.A[3]).tex('uHiB', this.A[5])
      .m4('uMVP', mvp).f('uShellR', 1.02)
      .v3('uSun', sun[0], sun[1], sun[2]).f('uNight', P.nightShading);
    gl.drawElements(gl.TRIANGLES, this.grid.indices.length, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  if (P.showParticles) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    var pp = this.prog.points.use();
    this.gridUniforms(pp);
    pp.tex('uPart', this.partTex[this.partIdx]).tex('uLookup', this.texLookup)
      .tex('uLoA', this.A[2]).tex('uTop', this.A[0])
      .iv2('uPDim', this.PW, this.PH).m4('uMVP', mvp).f('uEquirect', 0.0)
      .f('uPointSize', P.pointSize * Math.min(2, dpr))
      .f('uOcean', P.particleOcean);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(gl.POINTS, 0, this.PW * this.PH);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }
  gl.bindVertexArray(null);
};

Planet.prototype.renderEquirect = function (w, h, sun) {
  var gl = this.gl;
  var P = this.params;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);

  var eq = this.prog.equi.use();
  this.gridUniforms(eq);
  eq.tex('uTop', this.A[0]).tex('uDeep', this.A[1]).tex('uLoA', this.A[2])
    .tex('uLoB', this.A[3]).tex('uHiA', this.A[4]).tex('uHiB', this.A[5])
    .tex('uLookup', this.texLookup).i('uMode', P.mode)
    .v3('uSun', sun[0], sun[1], sun[2])
    .f('uShowLand', P.showLand).f('uNight', P.nightShading);
  gl.bindVertexArray(this.vaoEmpty);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  if (P.showClouds) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    var cl = this.prog.equiCloud.use();
    this.gridUniforms(cl);
    cl.tex('uLookup', this.texLookup).tex('uCellA', this.texCellA)
      .tex('uLoB', this.A[3]).tex('uHiB', this.A[5])
      .v3('uSun', sun[0], sun[1], sun[2]).f('uNight', P.nightShading);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  if (P.showParticles) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    var pp = this.prog.points.use();
    this.gridUniforms(pp);
    pp.tex('uPart', this.partTex[this.partIdx]).tex('uLookup', this.texLookup)
      .tex('uLoA', this.A[2]).tex('uTop', this.A[0])
      .iv2('uPDim', this.PW, this.PH).f('uEquirect', 1.0)
      .f('uPointSize', P.pointSize * Math.min(2, window.devicePixelRatio || 1))
      .f('uOcean', P.particleOcean);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(gl.POINTS, 0, this.PW * this.PH);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
};

Planet.prototype.loop = function () {
  if (this.disposed) return;
  this.raf = requestAnimationFrame(this._loop);
  var P = this.params;
  if (P.running) {
    for (var i = 0; i < P.substeps; i++) this.step();
    this.stepParticles(P.dt * P.substeps);
  }
  this.render();
  this.frames++;
  var now = performance.now();
  if (now - this.lastFps > 500) {
    this.fps = (this.frames * 1000) / (now - this.lastFps);
    this.frames = 0; this.lastFps = now;
    if (this.onStats) this.onStats({
      fps: this.fps, days: this.simTime / 86400,
      cells: this.grid.V, level: this.grid.level,
    });
  }
};

Planet.prototype.bindInput = function () {
  var c = this.canvas;
  c.addEventListener('pointerdown', this._onDown);
  window.addEventListener('pointerup', this._onUp);
  window.addEventListener('pointermove', this._onMove);
  c.addEventListener('wheel', this._onWheel, { passive: false });
};
Planet.prototype.dispose = function () {
  this.disposed = true;
  cancelAnimationFrame(this.raf);
  var c = this.canvas;
  c.removeEventListener('pointerdown', this._onDown);
  window.removeEventListener('pointerup', this._onUp);
  window.removeEventListener('pointermove', this._onMove);
  c.removeEventListener('wheel', this._onWheel);
  this.destroyGrid();
};
