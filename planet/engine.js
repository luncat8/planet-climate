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
/* PARAMS, defaultParams(), boundsOf(), setBound(), clamp() and the preset
   helpers now live in params.js (loaded before this file). Only the per-instance
   state is initialized here. */

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
  this.part = [];
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
  this.prog.cloud = new Prog(gl, CLOUD_VS, CLOUD_FS, 'cloud');
  this.prog.equiCloud = new Prog(gl, EQUI_VS, EQUI_CLOUD_FS, 'equiCloud');
  // Render programs are compiled lazily per mode (see getGlobeProg/getEquiProg)
  // so the selected mode is baked into the GLSL source with no runtime branch.
  this.prog.globeByMode = {};
  this.prog.equiByMode = {};
};
Planet.prototype.getGlobeProg = function (m) {
  var c = this.prog.globeByMode;
  if (!c[m]) c[m] = new Prog(this.gl, GLOBE_VS(m), GLOBE_FS(m), 'globe' + m);
  return c[m];
};
Planet.prototype.getEquiProg = function (m) {
  var c = this.prog.equiByMode;
  if (!c[m]) c[m] = new Prog(this.gl, EQUI_VS, EQUI_FS(m), 'equi' + m);
  return c[m];
};

Planet.prototype.build = function (level) {
  var gl = this.gl;
  this.destroyGrid();
  /* Grid generation now depends on the ocean-geometry params (bathymetry is
     baked into the static uCellC texture), so any change to those must go
     through rebuild(), not a live uniform update. Seeded explicitly: reset()
     used to call Math.random(), which made runs unreproducible. */
  var gp = this.params || {};
  var g = new Grid(level, gp.seed === undefined ? 12345 : gp.seed, {
    bathyMode:  gp.bathyMode,  hTotal:     gp.hTotal,
    hTop:       gp.hTop,       depthMax:   gp.depthMax,
    shelfWidth: gp.shelfWidth, bathyRough: gp.bathyRough,
    dShelf:     gp.dShelf,
  }).build();
  this.grid = g;
  var W = g.W, H = g.H;

  this.texCellA = this.mkTex(W, H, g.cellA);
  this.texCellB = this.mkTex(W, H, g.cellB);
  this.texCellC = this.mkTex(W, H, g.cellC);
  this.texNbrA = this.mkTex(W, H * 6, g.nbrA);
  this.texNbrB = this.mkTex(W, H * 6, g.nbrB);
  this.texLookup = this.mkTex(g.lookupW, g.lookupH, g.lookup, 1);

  // State layout (each RGBA32F, ping-ponged A <-> B):
  //   [0] topS  = (h_top, T_top, S_top, _)
  //   [1] topV  = (u_top, v_top, _, _)
  //   [2] deepS = (T_deep, S_deep, _, _)     h_deep = hTotal - h_top (derived)
  //   [3] deepV = (u_deep, v_deep, _, _)
  //   [4] loA = (u,v,T,P)  [5] loB = (q,cloud,_,_)
  //   [6] hiA = (u,v,T,P)  [7] hiB = (q,rain,_,_)
  this.A = []; this.B = [];
  for (var i = 0; i < 8; i++) {
    this.A.push(this.mkTex(W, H, null));
    this.B.push(this.mkTex(W, H, null));
  }
  this.fbo.dynO = this.mkFbo([this.B[0], this.B[1], this.B[2], this.B[3]]);
  this.fbo.dynA = this.mkFbo([this.B[4], this.B[5], this.B[6], this.B[7]]);
  this.fbo.cplO = this.mkFbo([this.A[0], this.A[1], this.A[2], this.A[3]]);
  this.fbo.cplA = this.mkFbo([this.A[4], this.A[5], this.A[6], this.A[7]]);
  this.fbo.init = this.mkFbo([this.A[0], this.A[1], this.A[2], this.A[3]]);   // ocean
  this.fbo.init2 = this.mkFbo([this.A[4], this.A[5], this.A[6], this.A[7]]); // air

  var pdata = new Float32Array(this.PW * this.PH * 4);
  var prnd = Grid.mulberry32(((this.params.seed === undefined ? 12345 : this.params.seed) ^ 0x9e37) >>> 0);
  for (var j = 0; j < this.PW * this.PH; j++) {
    var z = prnd() * 2 - 1, a = prnd() * 6.2831853, r = Math.sqrt(1 - z * z);
    pdata[j * 4] = r * Math.cos(a); pdata[j * 4 + 1] = z; pdata[j * 4 + 2] = r * Math.sin(a);
    pdata[j * 4 + 3] = prnd();
  }
  var self = this;
  var streamLayers = [
    { velMode:2, velScale:1,  color:[1,0,0] },
    { velMode:0, velScale:1,  color:[0,1,0] },
    { velMode:1, velScale:6,  color:[0,0,1] },
    { velMode:3, velScale:60, color:[1,1,1] },
  ];
  this.part = streamLayers.map(function (L, i) {
    var a = self.mkTex(self.PW, self.PH, pdata), b = self.mkTex(self.PW, self.PH, pdata);
    var fa = self.mkFbo([a]), fb = self.mkFbo([b]);
    self.fbo['part' + i + 'a'] = fa; self.fbo['part' + i + 'b'] = fb;
    return { tex:[a,b], idx:0, fboA:'part' + i + 'a', fboB:'part' + i + 'b',
             velMode:L.velMode, velScale:L.velScale, color:L.color };
  });

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
  var partTexs = this.part.reduce(function (a, s) { return a.concat(s.tex); }, []);
  var all = this.A.concat(this.B, partTexs, [this.texCellA, this.texCellB, this.texCellC, this.texNbrA, this.texNbrB, this.texLookup]);
  all.forEach(function (t) { if (t) gl.deleteTexture(t); });
  Object.keys(this.fbo).forEach(function (k) { gl.deleteFramebuffer(this.fbo[k]); }, this);
  this.fbo = {};
  if (this.ibo) gl.deleteBuffer(this.ibo);
  if (this.vaoGlobe) gl.deleteVertexArray(this.vaoGlobe);
  if (this.vaoEmpty) gl.deleteVertexArray(this.vaoEmpty);
  this.A = []; this.B = []; this.part = [];
};

Planet.prototype.gridUniforms = function (p) {
  p.iv2('uDim', this.grid.W, this.grid.H).i('uCount', this.grid.V)
    .tex('uCellA', this.texCellA).tex('uCellB', this.texCellB)
    .tex('uCellC', this.texCellC)
    .tex('uNbrA', this.texNbrA).tex('uNbrB', this.texNbrB)
    .f('uHmin', this.params.hMin === undefined ? 40 : this.params.hMin)
    .f('uRiCrit', this.params.riCrit === undefined ? 0.25 : this.params.riCrit)
    .f('uMixConv', this.params.mixConv === undefined ? 50 : this.params.mixConv);
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

/* Deterministic seed stream. reset() previously drew uSeed from Math.random(),
   so two runs of the same preset produced different oceans and no result could
   be reproduced or regression-tested. Derived from params.seed instead. */
Planet.prototype.seedRand = function () {
  if (!this._rng) {
    var s0 = this.params.seed === undefined ? 12345 : this.params.seed;
    this._rng = Grid.mulberry32(s0 >>> 0);
  }
  return this._rng();
};
Planet.prototype.reset = function () {
  var W = this.grid.W, H = this.grid.H;
  this.simTime = 0;
  /* Restart the stream so reset() is idempotent for a given seed. */
  this._rng = null;
  var p = this.prog.init.use();
  this.gridUniforms(p);
  p.f('uSeed', this.seedRand() * 1000)
    .f('uHtop', this.params.hTop).f('uHtotal', this.params.hTotal);
  this.fullscreen('init', W, H);
  var p2 = this.prog.init2.use();
  this.gridUniforms(p2); p2.f('uSeed', this.seedRand() * 1000);
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
    pr.tex('uTopS', src[0]).tex('uTopV', src[1])
      .tex('uDeepS', src[2]).tex('uDeepV', src[3])
      .tex('uLoA', src[4]).tex('uLoB', src[5])
      .tex('uHiA', src[6]).tex('uHiB', src[7]);
    pr.f('uDt', P.dt).f('uTime', self.simTime)
      .v3('uSun', sun[0], sun[1], sun[2])
      .f('uSolar', P.solar).f('uDayNight', P.dayNight).f('uSeasonDecl', self.decl())
      .f('uKsurf', P.kSurf).f('uEvap', P.evap).f('uWindStress', P.windStress)
      .f('uConv', P.conv).f('uKrad', P.kRad).f('uLapse', P.lapse)
      .f('uThermo', P.thermo).f('uCloudK', P.cloudK).f('uRainK', P.rainK)
      .f('uNoise', P.noise).f('uGreenhouse', P.greenhouse)
      .f('uSurfMass', P.surfMass)
      .f('uVertHeat', P.verticalHeat).f('uVertSalt', P.verticalSalt)
      .f('uHtot', P.hTotal);
    self.fullscreen(pair[0], W, H);
  });
};

Planet.prototype.decl = function () {
  return 0.4084 * Math.sin((this.simTime / (365 * 86400)) * 6.2831853);
};
Planet.prototype.sunDir = function () {
  var d = this.decl();
  
  // omegaOrbit alone controls how fast the sub-solar point slides across the
  // surface (the day/night cycle) — independent of omegaSpin, which only feeds
  // the Coriolis term. Set omegaOrbit = 0 to freeze the sun entirely (tidal
  // lock) while keeping a physically-motivated Coriolis force from the
  // planet's real rotation.
  var lon = this.params.omegaOrbit * this.simTime;
  
  return [Math.cos(d) * Math.cos(lon), Math.sin(d), Math.cos(d) * Math.sin(lon)];
};

Planet.prototype.step = function () {
  var W = this.grid.W, H = this.grid.H;
  var P = this.params;

  // Ocean dynamics: flux-form continuity for h_top, pressure gradient
  // -g*grad(h) on top / +g'*grad(h) on deep, equal-and-opposite inter-layer
  // drag, then tracer advection + diffusion.  A -> B
  var po = this.prog.ocean.use();
  this.gridUniforms(po);
  po.tex('uTopS', this.A[0]).tex('uTopV', this.A[1])
    .tex('uDeepS', this.A[2]).tex('uDeepV', this.A[3])
    .f('uDt', P.dt).f('uOmega', P.omegaSpin)
    .f('uNuVel', P.nuVelOcean).f('uNuT', P.nuTOcean)
    .f('uFricTop', P.fricOceanTop).f('uFricDeep', P.fricOceanDeep)
    .f('uCdBottom', P.cdBottom).f('uFricDepthRef', P.fricDepthRef)
    .f('uAlphaT', 1.7e-4).f('uBetaS', 7.8e-4)
    .f('uDrag', P.oceanDrag + P.mechanicalFric)
    .f('uSteric', P.steric).f('uStericRate', P.stericRate)
    .f('uMassSpring', P.massSpring)
    .f('uHtot', P.hTotal).f('uHref', P.hTop)
    .f('uPgfTop', P.pgfTop).f('uPgfDeepGain', P.pgfDeepGain)
    .f('uRhieChow', P.rhieChow).f('uCoriCN', P.coriCN ? 1 : 0)
    .f('uFbStab', P.fbStab);
  this.fullscreen('dynO', W, H);

  var pa = this.prog.air.use();
  this.gridUniforms(pa);
  pa.tex('uLoA', this.A[4]).tex('uLoB', this.A[5]).tex('uHiA', this.A[6]).tex('uHiB', this.A[7])
    .f('uDt', P.dt).f('uOmega', P.omegaSpin)
    .f('uNuVel', P.nuVelAir).f('uNuT', P.nuTAir)
    .f('uFricLo', P.fricAirLow).f('uFricHi', P.fricAirHigh)
    .f('uRhoLo', 1.1).f('uRhoHi', 0.55);
  this.fullscreen('dynA', W, H);

  this.couple();
  this.simTime += P.dt;
};

Planet.prototype.stepParticles = function (dt) {
  var gl = this.gl;
  for (var i = 0; i < this.part.length; i++) {
    var s = this.part[i];
    var src = s.tex[s.idx];
    var dstFbo = s.idx === 0 ? s.fboB : s.fboA;
    var p = this.prog.part.use();
    this.gridUniforms(p);
    p.tex('uPart', src).tex('uLookup', this.texLookup)
      .tex('uLoA', this.A[4]).tex('uTopV', this.A[1]).tex('uHiA', this.A[6]).tex('uDeepV', this.A[3])
      .iv2('uPDim', this.PW, this.PH)
      .f('uDt', dt).f('uLife', 60 * 3600).f('uRadius', PLANET_R)
      .f('uSeed', this.seedRand() * 1000)
      .i('uVelMode', s.velMode).f('uVelScale', s.velScale);
    this.fullscreen(dstFbo, this.PW, this.PH);
    s.idx = 1 - s.idx;
  }
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

  var g = this.getGlobeProg(P.mode).use();
  this.gridUniforms(g);
  g.tex('uTopS', this.A[0]).tex('uTopV', this.A[1])
    .tex('uDeepS', this.A[2]).tex('uDeepV', this.A[3])
    .tex('uLoA', this.A[4]).tex('uLoB', this.A[5])
    .tex('uHiA', this.A[6]).tex('uHiB', this.A[7])
    .m4('uMVP', mvp)
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
    cl.tex('uLoB', this.A[5]).tex('uHiB', this.A[7])
      .m4('uMVP', mvp).f('uShellR', 1.02)
      .v3('uSun', sun[0], sun[1], sun[2]).f('uNight', P.nightShading);
    gl.drawElements(gl.TRIANGLES, this.grid.indices.length, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  var dots = P.streamTrail <= 0;
  var psz = 2.0 * Math.min(2, dpr);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);
  for (var pi = 0; pi < this.part.length; pi++) {
    if (((P.streamline >> pi) & 1) === 0) continue;
    var ps = this.part[pi];
    var pp = this.prog.points.use();
    this.gridUniforms(pp);
    pp.tex('uPart', ps.tex[ps.idx]).tex('uLookup', this.texLookup)
      .tex('uLoA', this.A[4]).tex('uTopV', this.A[1]).tex('uHiA', this.A[6]).tex('uDeepV', this.A[3])
      .iv2('uPDim', this.PW, this.PH).m4('uMVP', mvp).f('uEquirect', 0.0)
      .f('uTrail', P.streamTrail).f('uRadius', PLANET_R)
      .f('uAsPoints', dots ? 1 : 0).f('uPointSize', psz)
      .i('uVelMode', ps.velMode).f('uVelScale', ps.velScale)
      .v3('uColor', ps.color[0], ps.color[1], ps.color[2]);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(dots ? gl.POINTS : gl.LINES, 0, this.PW * this.PH * (dots ? 1 : 2));
  }
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.enable(gl.CULL_FACE);
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

  var eq = this.getEquiProg(P.mode).use();
  this.gridUniforms(eq);
  eq.tex('uTopS', this.A[0]).tex('uTopV', this.A[1])
    .tex('uDeepS', this.A[2]).tex('uDeepV', this.A[3])
    .tex('uLoA', this.A[4]).tex('uLoB', this.A[5])
    .tex('uHiA', this.A[6]).tex('uHiB', this.A[7])
    .tex('uLookup', this.texLookup)
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
      .tex('uLoB', this.A[5]).tex('uHiB', this.A[7])
      .v3('uSun', sun[0], sun[1], sun[2]).f('uNight', P.nightShading);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  var dots = P.streamTrail <= 0;
  var psz = 2.0 * Math.min(2, window.devicePixelRatio || 1);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.depthMask(false);
  for (var pi = 0; pi < this.part.length; pi++) {
    if (((P.streamline >> pi) & 1) === 0) continue;
    var ps = this.part[pi];
    var pp = this.prog.points.use();
    this.gridUniforms(pp);
    pp.tex('uPart', ps.tex[ps.idx]).tex('uLookup', this.texLookup)
      .tex('uLoA', this.A[4]).tex('uTopV', this.A[1]).tex('uHiA', this.A[6]).tex('uDeepV', this.A[3])
      .iv2('uPDim', this.PW, this.PH).f('uEquirect', 1.0)
      .f('uTrail', P.streamTrail).f('uRadius', PLANET_R)
      .f('uAsPoints', dots ? 1 : 0).f('uPointSize', psz)
      .i('uVelMode', ps.velMode).f('uVelScale', ps.velScale)
      .v3('uColor', ps.color[0], ps.color[1], ps.color[2]);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(dots ? gl.POINTS : gl.LINES, 0, this.PW * this.PH * (dots ? 1 : 2));
  }
  gl.depthMask(true);
  gl.disable(gl.BLEND);
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
