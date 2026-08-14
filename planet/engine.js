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
  this.stepCount = 0;
  this.onStats = null;

  this.A = []; this.B = [];
  this.texCellA = null; this.texCellB = null;
  this.texNbrA = null; this.texNbrB = null;
  this.texLookup = null;
  this.pools = [];
  this.PW = 128; this.PH = 128;   // flow-viz particle grid (PW*PH tracers per pool)
  this.PT = 40;                   // trail history length (slots per tracer)

  this.fbo = {};
  this.prog = {};
  this.vaoGlobe = null; this.vaoEmpty = null; this.ibo = null;
  this.raf = 0;
  this.frames = 0; this.lastFps = performance.now(); this.fps = 60;
  this.cam = { theta: 0.6, phi: 0.25, dist: 3.0 };
  this.drag = false; this.lx = 0; this.ly = 0;
  this.disposed = false;
  /* Per-iteration residual readback for scheme B. Off by default: the readback
     forces a full GPU->CPU sync (pipeline stall) on every Jacobi iteration,
     which dominates interactive cost. The harness sets this true to retain the
     convergence early-exit + residual history without slowing the UI. */
  this.trackResidual = false;
  this.residualHistory = [];
  this.lastJacobiIters = 0;

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
  this.prog.oceanPredict = new Prog(gl, QUAD_VS, OCEAN_PREDICT_FS, 'oceanPredict');
  this.prog.oceanRhs = new Prog(gl, QUAD_VS, OCEAN_RHS_FS, 'oceanRhs');
  this.prog.oceanJacobi = new Prog(gl, QUAD_VS, OCEAN_JACOBI_FS, 'oceanJacobi');
  this.prog.oceanCorrect = new Prog(gl, QUAD_VS, OCEAN_CORRECT_FS, 'oceanCorrect');
  this.prog.baroDiv = new Prog(gl, QUAD_VS, BARO_DIV_FS, 'baroDiv');
  this.prog.baroJacobi = new Prog(gl, QUAD_VS, BARO_JACOBI_FS, 'baroJacobi');
  this.prog.baroCorrect = new Prog(gl, QUAD_VS, BARO_CORRECT_FS, 'baroCorrect');
  this.prog.baroCopy = new Prog(gl, QUAD_VS, BARO_COPY_FS, 'baroCopy');
  this.prog.maxRed = new Prog(gl, QUAD_VS, MAX_FS, 'maxRed');
  this.prog.air = new Prog(gl, QUAD_VS, AIR_FS, 'air');
  this.prog.cplO = new Prog(gl, QUAD_VS, COUPLE_FS('ocean'), 'coupleOcean');
  this.prog.cplA = new Prog(gl, QUAD_VS, COUPLE_FS('air'), 'coupleAir');
  this.prog.init = new Prog(gl, QUAD_VS, INIT_FS, 'init');
  this.prog.init2 = new Prog(gl, QUAD_VS, INIT2_FS, 'init2');
  this.prog.vflow = new Prog(gl, QUAD_VS, VFLOW_FS, 'vflow');
  this.prog.iceDyn = new Prog(gl, QUAD_VS, ICE_DYN_FS, 'iceDyn');
  this.prog.reduce = new Prog(gl, QUAD_VS, REDUCE_FS, 'reduce');
  this.prog.state = new Prog(gl, QUAD_VS, STATE_FS, 'state');
  this.prog.trail = new Prog(gl, QUAD_VS, TRAIL_FS, 'trail');
  this.prog.smooth = new Prog(gl, QUAD_VS, SMOOTH_FS, 'smooth');
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
    radius:     gp.planetRadius === undefined ? 6371e3 : gp.planetRadius,
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

  // Scheme-B scratch: predicted ocean state (4 attachments) + two eta ping-pong
  // textures + a 1x1 max-residual reduction target. Allocated always (cheap).
  this.P = [this.mkTex(W, H, null), this.mkTex(W, H, null),
            this.mkTex(W, H, null), this.mkTex(W, H, null)];
  this.fbo.P = this.mkFbo(this.P);
  // Barotropic projection: MRT targets to correct the two ocean velocity
  // fields (A[1]=topV, A[3]=deepV) plus a persistent barotropic potential phi
  // (texPhi) that warm-starts the Jacobi solve across substeps. Scratch
  // snapshot in P[1]/P[3].
  this.texPhi = this.mkTex(W, H, null);
  this.fbo.oceanV = this.mkFbo([this.A[1], this.A[3], this.texPhi]);
  this.fbo.baroV  = this.mkFbo([this.P[1], this.P[3]]);
  this.texEtaA = this.mkTex(W, H, null);
  this.texEtaB = this.mkTex(W, H, null);
  this.fbo.etaA = this.mkFbo([this.texEtaA]);
  this.fbo.etaB = this.mkFbo([this.texEtaB]);
  this.texMaxRes = this.mkTex(1, 1, null);
  this.fbo.maxRes = this.mkFbo([this.texMaxRes]);

  /* ---- Cryosphere ice field (see CRYOSPHERE.md) -------------------------
     Dedicated ping-pong texture (iceThk, iceFrac, _, _). Kept OUT of the 8
     saved ocean/air textures so the tuned ocean-dynamics shaders are untouched;
     persisted by packing into free channels of A[3] at (de)serialize time. */
  this.ice = [this.mkTex(W, H, new Float32Array(W * H * 4)),
              this.mkTex(W, H, new Float32Array(W * H * 4))];
  this.fbo.ice0 = this.mkFbo([this.ice[0]]);
  this.fbo.ice1 = this.mkFbo([this.ice[1]]);
  this.iceIdx = 0;

  /* Carbon-cycle global reduction target: a single 1x1 float attachment (the
     exact pattern proven by fbo.maxRes). Filled by two REDUCE_FS draws. */
  this.texReduce0 = this.mkTex(1, 1, new Float32Array(4));
  this.fbo.reduce = this.mkFbo([this.texReduce0]);
  this.globals = null;

  /* ---- Flow-visualisation particle pools -------------------------------
     TWO pools — ocean {top,deep} and air {low,high}. Each particle carries a
     sublayer (packed into state.w = sublayer + agePhase) and MOVES between the
     two sublayers with probability proportional to the vertical mass flux, so
     it traces the overturning circulation instead of being pinned to one layer.
     Per pool:
       * state A/B  (PW x PH)      : head .xyz + (sublayer + life phase) in .w
       * trail A/B  (PW x PH*PT)   : last PT positions (.xyz) + sublayer (.w),
                                     a conveyor shifted one slot per frame.
     Double-buffered (a frame reads the whole trail while rewriting it). */
  var self = this;
  this.buildPools();

  // Vertical-flow field: .x = ocean interface w, .y = air w (see VFLOW_FS).
  this.texVFlow = this.mkTex(W, H, null);
  this.fbo.vflow = this.mkFbo([this.texVFlow]);
  this.vflowInit = false;

  /* Temporally-averaged velocity (RG in .xy) for the 4 sources feeding the two
     pools' sublayers: 0 = ocean top (A1), 1 = ocean deep (A3), 2 = low air
     (A4), 3 = high air (A6). Updated once per frame by SMOOTH_FS. */
  this.smoothSrc = [1, 3, 4, 6];
  this.smooth = this.smoothSrc.map(function (srcIdx, i) {
    var a = self.mkTex(W, H, null), b = self.mkTex(W, H, null);
    self.fbo['smooth' + i + 'a'] = self.mkFbo([a]); self.fbo['smooth' + i + 'b'] = self.mkFbo([b]);
    return { tex:[a, b], idx:0, fboA:'smooth' + i + 'a', fboB:'smooth' + i + 'b', srcIdx: srcIdx };
  });
  this.smoothInit = false;   // first pass copies the raw field (alpha=1)

  this.ibo = gl.createBuffer();
  this.vaoGlobe = gl.createVertexArray();
  gl.bindVertexArray(this.vaoGlobe);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  this.vaoEmpty = gl.createVertexArray();

  this.reset();
};

/* Build the two flow-viz particle pools (ocean {top,deep}, air {low,high}).
   Grid dimensions PW*PH come from params.flowParticles (thousands of tracers
   PER pool); a bigger count costs more per-frame GPU work but is a one-time,
   rarely-changed setting, so we simply rebuild the pool textures when it moves
   (rebuildPools) rather than trying to resize live — favouring steady-state
   draw/update speed over cheap changes, per design. Independent of the physics
   grid, so it can be rebuilt without touching the simulation state. */
Planet.prototype.buildPools = function () {
  var self = this;
  var kp = (this.params && this.params.flowParticles !== undefined) ? this.params.flowParticles : 16;
  var side = Math.max(8, Math.round(Math.sqrt(Math.max(1000, kp * 1000))));
  /* Clamp to the GPU's texture limit: the trail texture is PW x (PH*PT), so its
     height (side*PT) must fit MAX_TEXTURE_SIZE. On a typical 16384 GPU this caps
     at ~167k/pool (well above the slider's 64k max); tiny/software GLs clamp
     lower but never error. */
  var maxTex = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) || 4096;
  side = Math.min(side, maxTex, Math.floor(maxTex / this.PT));
  this.PW = side; this.PH = side;
  var prnd = Grid.mulberry32(((this.params.seed === undefined ? 12345 : this.params.seed) ^ 0x9e37) >>> 0);
  var Np = this.PW * this.PH, T = this.PT;
  function seedPool() {
    var sdata = new Float32Array(Np * 4);
    var tdata = new Float32Array(Np * T * 4);
    for (var j = 0; j < Np; j++) {
      var z = prnd() * 2 - 1, a = prnd() * 6.2831853, r = Math.sqrt(1 - z * z);
      var dx = r * Math.cos(a), dy = z, dz = r * Math.sin(a);
      var layer = prnd() < 0.5 ? 0 : 1;
      var wPacked = layer + Math.min(0.9999, prnd());   // sublayer + random life phase
      sdata[j * 4] = dx; sdata[j * 4 + 1] = dy; sdata[j * 4 + 2] = dz; sdata[j * 4 + 3] = wPacked;
      for (var s = 0; s < T; s++) {
        var ti = (s * Np + j) * 4;
        tdata[ti] = dx; tdata[ti + 1] = dy; tdata[ti + 2] = dz; tdata[ti + 3] = layer;
      }
    }
    return { sdata: sdata, tdata: tdata };
  }
  // Pool config. wChan: 0 = ocean (uVFlow.x), 1 = air (uVFlow.y).
  // fluxSign chosen so f>0 favours sublayer 0->1: ocean top->deep = sinking =
  // downwelling (vflow.x<0 => -x>0); air low->high = ascent (vflow.y>0).
  // idx0/idx1 map the two sublayers to the LAYER_VIEW streamline bits
  // (highAir=0, lowAir=1, ocean=2, deepOcean=3).
  var poolCfg = [
    { name:'ocean', vel:[1,3], mul:[6,60], smooth:[0,1], wChan:0, fluxSign:-1, wScale:1.5e-3,
      col:[[0.23,0.51,0.96],[0.96,0.96,0.96]], idx:[2,3] },
    { name:'air',   vel:[4,6], mul:[1,1],  smooth:[2,3], wChan:1, fluxSign:+1, wScale:4.4e-2,
      col:[[0.15,0.89,0.42],[1.0,0.23,0.23]], idx:[1,0] },
  ];
  this.pools = poolCfg.map(function (P, i) {
    var s = seedPool();
    var sa = self.mkTex(self.PW, self.PH, s.sdata), sb = self.mkTex(self.PW, self.PH, s.sdata);
    var ta = self.mkTex(self.PW, self.PH * T, s.tdata), tb = self.mkTex(self.PW, self.PH * T, s.tdata);
    self.fbo['st' + i + 'a'] = self.mkFbo([sa]); self.fbo['st' + i + 'b'] = self.mkFbo([sb]);
    self.fbo['tr' + i + 'a'] = self.mkFbo([ta]); self.fbo['tr' + i + 'b'] = self.mkFbo([tb]);
    return { cfg: P, state:[sa, sb], trail:[ta, tb], idx:0 };
  });
};

/* Rebuild just the particle pools (after the count slider changes) without
   disturbing the physics grid or its equilibrium state. */
Planet.prototype.rebuildPools = function () {
  if (!this.grid) return;
  var gl = this.gl, self = this;
  (this.pools || []).forEach(function (p, i) {
    p.state.concat(p.trail).forEach(function (t) { if (t) gl.deleteTexture(t); });
    ['st' + i + 'a', 'st' + i + 'b', 'tr' + i + 'a', 'tr' + i + 'b'].forEach(function (k) {
      if (self.fbo[k]) { gl.deleteFramebuffer(self.fbo[k]); delete self.fbo[k]; }
    });
  });
  this.pools = [];
  this.buildPools();
};

Planet.prototype.destroyGrid = function () {
  var gl = this.gl;
  var partTexs = (this.pools || []).reduce(function (a, s) { return a.concat(s.state, s.trail); }, []);
  if (this.smooth) partTexs = this.smooth.reduce(function (a, s) { return a.concat(s.tex); }, partTexs);
  if (this.texVFlow) partTexs.push(this.texVFlow);
  if (this.ice) partTexs = partTexs.concat(this.ice);
  if (this.texReduce0) partTexs.push(this.texReduce0);
  var all = this.A.concat(this.B, partTexs, [this.texCellA, this.texCellB, this.texCellC, this.texNbrA, this.texNbrB, this.texLookup]);
  if (this.P) all = all.concat(this.P, [this.texEtaA, this.texEtaB, this.texMaxRes, this.texPhi]);
  all.forEach(function (t) { if (t) gl.deleteTexture(t); });
  Object.keys(this.fbo).forEach(function (k) { gl.deleteFramebuffer(this.fbo[k]); }, this);
  this.fbo = {};
  if (this.ibo) gl.deleteBuffer(this.ibo);
  if (this.vaoGlobe) gl.deleteVertexArray(this.vaoGlobe);
  if (this.vaoEmpty) gl.deleteVertexArray(this.vaoEmpty);
  this.A = []; this.B = []; this.pools = []; this.smooth = []; this.texVFlow = null; this.ice = null; this.texReduce0 = null;
};

/* Advance the smoothed-velocity EMA one frame for the 4 sublayer sources.
   alpha = 1 - flowSmooth (higher "Averaging strength" = smaller alpha = longer
   memory). The first pass after (re)build copies the raw field (warm start). */
Planet.prototype.stepSmooth = function () {
  var gl = this.gl;
  var P = this.params;
  var s = P.flowSmooth === undefined ? 0.9 : P.flowSmooth;
  var alpha = this.smoothInit ? Math.max(0.0, Math.min(1.0, 1.0 - s)) : 1.0;
  for (var i = 0; i < this.smooth.length; i++) {
    var sm = this.smooth[i];
    var src = sm.tex[sm.idx];
    var dstFbo = sm.idx === 0 ? sm.fboB : sm.fboA;
    var pr = this.prog.smooth.use();
    pr.tex('uCur', this.A[sm.srcIdx]).tex('uPrev', src).f('uAlpha', alpha);
    this.fullscreen(dstFbo, this.grid.W, this.grid.H);
    sm.idx = 1 - sm.idx;
  }
  this.smoothInit = true;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
};
Planet.prototype.smoothTex = function (i) {
  var sm = this.smooth[i];
  return sm.tex[sm.idx];
};

Planet.prototype.gridUniforms = function (p) {
  p.iv2('uDim', this.grid.W, this.grid.H).i('uCount', this.grid.V)
    .tex('uCellA', this.texCellA).tex('uCellB', this.texCellB)
    .tex('uCellC', this.texCellC)
    .tex('uNbrA', this.texNbrA).tex('uNbrB', this.texNbrB)
    .f('uHmin', this.params.hMin === undefined ? 40 : this.params.hMin)
    .f('uRiCrit', this.params.riCrit === undefined ? 0.25 : this.params.riCrit)
    .f('uMixConv', this.params.mixConv === undefined ? 50 : this.params.mixConv)
    .f('uPlow', this.params.surfacePressure === undefined ? 101325 : this.params.surfacePressure)
    .f('uPhigh', (this.params.surfacePressure === undefined ? 101325 : this.params.surfacePressure) * 0.442692);
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
  this.gridUniforms(p2);
  p2.f('uSeed', this.seedRand() * 1000)
    .f('uGravity', this.params.gravity).f('uRhoLo', this.params.atmosDensity);
  this.fullscreen('init2', W, H);
  // cryosphere spins up from zero
  if (this.ice) {
    var zero = new Float32Array(W * H * 4);
    this.writeTex(this.ice[0], zero); this.writeTex(this.ice[1], zero); this.iceIdx = 0;
  }
};

/* ============ state save / load ============
   The persistent simulation state lives in the 8 RGBA32F textures this.A
   (ocean [0..3] + air [4..7]); this.B is scratch, recomputed every step, so
   it never needs saving. We read the textures back to the CPU, upload them
   again on load, and restore the parameter snapshot + clock. The render/update
   FBOs reference the SAME texture objects, so re-uploading in place keeps them
   valid (no rebuild required). */

Planet.prototype.readTex = function (tex) {
  var gl = this.gl, W = this.grid.W, H = this.grid.H;
  var fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  var buf = new Float32Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  return buf;
};

Planet.prototype.writeTex = function (tex, data) {
  var gl = this.gl, W = this.grid.W, H = this.grid.H;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
};

Planet.prototype.serializeState = function () {
  var g = this.grid;
  var A = [0, 1, 2, 3, 4, 5, 6, 7].map(function (i) { return this.readTex(this.A[i]); }, this);
  /* Pack the cryosphere field into free channels of A[3] (oDeepV.zw), which the
     ocean dynamics overwrite every step so the live sim never reads them. This
     keeps the 8-texture codec, mksave.js and baselines untouched. */
  var ice = this.readTex(this.iceTex());
  for (var i = 0; i < g.W * g.H; i++) { A[3][i * 4 + 2] = ice[i * 4 + 0]; A[3][i * 4 + 3] = ice[i * 4 + 1]; }
  return {
    version: 1,
    level: g.level, W: g.W, H: g.H,
    simTime: this.simTime, stepCount: this.stepCount,
    params: Object.assign({}, this.params),
    bounds: Object.assign({}, this.bounds),
    A: A,
  };
};

Planet.prototype.applyState = function (st) {
  if (!st || st.level === undefined) throw new Error('invalid state object');
  if (st.level !== this.grid.level)
    throw new Error('save is level ' + st.level + ', current grid is level ' + this.grid.level);
  for (var i = 0; i < 8; i++) this.writeTex(this.A[i], st.A[i]);
  /* Extract the packed cryosphere field from A[3].zw into the ice ping-pong
     (older saves without ice simply carry zeros here). */
  var g = this.grid, n = g.W * g.H, ice = new Float32Array(n * 4);
  var a3 = st.A[3];
  if (a3 && a3.length >= n * 4) {
    for (var k = 0; k < n; k++) { ice[k * 4] = a3[k * 4 + 2] || 0; ice[k * 4 + 1] = a3[k * 4 + 3] || 0; }
  }
  this.writeTex(this.ice[0], ice); this.writeTex(this.ice[1], ice); this.iceIdx = 0;
  this.params = Object.assign(defaultParams(), st.params);
  this.bounds = Object.assign({}, st.bounds || {});
  this.simTime = st.simTime || 0;
  this.stepCount = st.stepCount || 0;
  this.vflowInit = false;    // recompute the vertical-flow field from loaded state
  this.smoothInit = false;   // and re-seed the velocity EMA
  return this;
};

/* JSON (file) codec for states. The 8 float textures are base64-encoded so the
   whole thing is plain JSON and survives page.evaluate's structured-clone
   boundary. btoa/atob exist in browsers and Node >= 16, so this is shared by
   the app UI and the headless harness alike. */
function _f32ToB64(arr) {
  // Build the binary string in 32k-char chunks via String.fromCharCode.apply.
  // A single per-char `s +=` over ~1.3 MB is pathologically slow (~2 s for a
  // level-5 save) because it re-allocates the string every iteration.
  var src = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  var u = new Uint8Array(src.length);
  u.set(src);
  var s = '', CHUNK = 0x8000;
  for (var i = 0; i < u.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function _b64ToF32(b) {
  var s = atob(b);
  var u = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Float32Array(u.buffer);
}
function encodePlanetState(st) {
  return {
    version: st.version || 1, level: st.level, W: st.W, H: st.H,
    simTime: st.simTime, stepCount: st.stepCount,
    params: st.params, bounds: st.bounds || {},
    A: st.A.map(function (a) { return _f32ToB64(a); }),
  };
}
function decodePlanetState(o) {
  return {
    version: o.version || 1, level: o.level, W: o.W, H: o.H,
    simTime: o.simTime, stepCount: o.stepCount,
    params: o.params, bounds: o.bounds || {},
    A: o.A.map(function (b) { return _b64ToF32(b); }),
  };
}

/* A .js state file assigns its encoded object to a global so it can be loaded
 * with a plain <script src> tag — which works from file:// without fetch/CORS
 * headaches. The serialized form is plain JSON, so `window.PLANET_STATE = ...`
 * is valid JS and valid data. readPlanetStateJS() evaluates such a file and
 * returns the encoded object (callers run it through decodePlanetState). */
function planetStateToJS(enc) {
  return 'window.PLANET_STATE = ' + JSON.stringify(enc) + ';\n';
}
function readPlanetStateJS(text) {
  var sandbox = {};
  var fn = new Function('window', text + '\n;return (typeof PLANET_STATE !== "undefined") ? PLANET_STATE : (window.PLANET_STATE || undefined);');
  return fn(sandbox);
}

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
      .f('uHtot', P.hTotal)
      .f('uAirCs', P.airCs === undefined ? 40 : P.airCs)
      .f('uAirPRelax', P.airPRelax === undefined ? 8e-6 : P.airPRelax)
      .f('uAirDpdT', P.airDpdT === undefined ? 180 : P.airDpdT)
      .f('uAirDpdTHi', P.airDpdTHi === undefined ? 200 : P.airDpdTHi)
      .f('uGravity', P.gravity)
      .f('uRhoLo', P.atmosDensity);
    pr.tex('uIce', self.iceTex())
      .f('uIceOn', P.iceOn === undefined ? 0 : P.iceOn)
      .f('uAlbIce', P.iceAlbedo === undefined ? 0.62 : P.iceAlbedo)
      .f('uAlbSnow', P.snowAlbedo === undefined ? 0.78 : P.snowAlbedo)
      .f('uIceInsul', P.iceInsul === undefined ? 0.85 : P.iceInsul)
      .f('uIceH0', P.iceH0 === undefined ? 0.5 : P.iceH0)
      .f('uSice', P.iceSalinity === undefined ? 4 : P.iceSalinity)
      .f('uFreezeRate', P.iceFreezeRate === undefined ? 5e-5 : P.iceFreezeRate);
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
  if (P.oceanScheme === 2) {
    this.stepOceanB();                 // implicit free surface (Jacobi)
  } else {
    var po = this.prog.ocean.use();
    this.gridUniforms(po);
    /* Scheme A (1) decouples the heightmap: drop div(h*u) from continuity (the
       uScheme gate inside OCEAN_FS) and force the forward-backward / Rhie-Chow
       corrections inert so no wave-forming feedback can run. Scheme 0 is the
       unchanged explicit scheme. */
    var inert = (P.oceanScheme === 1);
    po.tex('uTopS', this.A[0]).tex('uTopV', this.A[1])
      .tex('uDeepS', this.A[2]).tex('uDeepV', this.A[3])
      .f('uDt', P.dt).f('uOmega', P.omegaSpin)
      .f('uNuVel', P.nuVelOcean).f('uNuT', P.nuTOcean)
      .f('uFricTop', P.fricOceanTop).f('uFricDeep', P.fricOceanDeep)
      .f('uCdBottom', P.cdBottom).f('uFricDepthRef', P.fricDepthRef)
      .f('uAlphaT', 1.7e-4).f('uBetaS', 7.8e-4)
      .f('uGravity', P.gravity)
      .f('uDrag', P.oceanDrag + P.mechanicalFric)
      .f('uSteric', P.steric).f('uStericRate', P.stericRate)
      .f('uMassSpring', P.massSpring)
      .f('uHtot', P.hTotal).f('uHref', P.hTop)
      .f('uPgfTop', P.pgfTop).f('uPgfDeepGain', P.pgfDeepGain)
      .f('uRhieChow', inert ? 0 : P.rhieChow)
      .f('uCoriCN', P.coriCN ? 1 : 0)
      .f('uFbStab', inert ? 0 : P.fbStab)
      .i('uScheme', P.oceanScheme | 0);
    this.fullscreen('dynO', W, H);
  }

  var pa = this.prog.air.use();
  this.gridUniforms(pa);
  pa.tex('uLoA', this.A[4]).tex('uLoB', this.A[5]).tex('uHiA', this.A[6]).tex('uHiB', this.A[7])
    .f('uDt', P.dt).f('uOmega', P.omegaSpin)
    .f('uNuVel', P.nuVelAir).f('uNuT', P.nuTAir)
    .f('uFricLo', P.fricAirLow).f('uFricHi', P.fricAirHigh)
    .f('uRhoLo', P.atmosDensity).f('uRhoHi', P.atmosDensity * 0.5)
    .f('uCoriCN', P.coriCN ? 1 : 0)
    .f('uCourantMax', P.airCourantMax)
    .f('uAirAdvect', P.airAdvect === undefined ? 0 : (P.airAdvect | 0))
    .f('uAirCs', P.airCs === undefined ? 40 : P.airCs)
    .f('uAirFbStab', P.airFbStab === undefined ? 20 : P.airFbStab);
  this.fullscreen('dynA', W, H);

  this.couple();
  if (P.rigidLid > 0.5) this.projectBarotropic();
  if (P.iceOn > 0.5) this.stepIce();
  this.simTime += P.dt;
  this.stepCount++;
};

/* Current (readable) ice texture. */
Planet.prototype.iceTex = function () { return this.ice[this.iceIdx]; };

/* Cryosphere transport pass (ICE_DYN_FS). Reads the current ice field + the
   per-step phase-change delta COUPLE_FS wrote into A[2] (uDeepS.zw), the surface
   wind (A[4]) and current (A[1]), and the static bed elevation; writes the
   next ice field (drift + SIA + calving, flux-form). Ping-pongs iceIdx. */
Planet.prototype.stepIce = function () {
  var W = this.grid.W, H = this.grid.H, P = this.params;
  var cur = this.iceIdx, nxt = 1 - cur;
  var pr = this.prog.iceDyn.use();
  this.gridUniforms(pr);
  pr.tex('uIce', this.ice[cur])
    .tex('uDeepS', this.A[2]).tex('uLoA', this.A[4]).tex('uTopV', this.A[1])
    .f('uDt', P.dt)
    .f('uDriftW', P.iceDriftWind === undefined ? 0.02 : P.iceDriftWind)
    .f('uDriftC', P.iceDriftCurrent === undefined ? 1.0 : P.iceDriftCurrent)
    .f('uDsia', P.iceSia === undefined ? 3e-8 : P.iceSia)
    .f('uThkMax', P.iceThkMax === undefined ? 60 : P.iceThkMax)
    .f('uIceH0', P.iceH0 === undefined ? 0.5 : P.iceH0);
  this.fullscreen(nxt === 1 ? 'ice1' : 'ice0', W, H);
  this.iceIdx = nxt;
  this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
};

/* Area-weighted global means for the carbon cycle (one REDUCE_FS draw + a
   2-pixel readback). Returns temperatures in K and area fractions. */
Planet.prototype.computeGlobals = function () {
  var gl = this.gl, P = this.params;
  var pr = this.prog.reduce.use();
  this.gridUniforms(pr);
  pr.tex('uTopS', this.A[0]).tex('uIce', this.iceTex())
    .f('uTopt', P.bioOptT === undefined ? 290 : P.bioOptT)
    .f('uTwidth', P.bioTwidth === undefined ? 12 : P.bioTwidth);
  var b0 = new Float32Array(4), b1 = new Float32Array(4);
  pr.i('uWhich', 0); this.fullscreen('reduce', 1, 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.reduce);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, b0);
  pr.i('uWhich', 1); this.fullscreen('reduce', 1, 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.reduce);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, b1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  var Aall = b0[1] || 1, Aoc = b0[3] || 1, Aifl = b1[1];
  return {
    meanT:   b0[0] / Aall,
    sstMean: b0[2] / Aoc,
    landT:   Aifl > 1 ? b1[0] / Aifl : b0[0] / Aall,
    areaTotal: Aall, areaOcean: Aoc,
    iceFreeLandFrac: b1[1] / Aall,
    suitOcean: b1[2], suitLand: b1[3],
  };
};

/* Atmospheric CO2 -> greenhouse factor, logarithmic radiative forcing. */
Planet.prototype.greenhouseFromCO2 = function () {
  var P = this.params;
  var ref = P.co2Ref === undefined ? 280 : P.co2Ref;
  var g0 = P.co2Green0 === undefined ? 0.55 : P.co2Green0;
  var s = P.co2Sens === undefined ? 0.09 : P.co2Sens;
  var c = Math.max(1, P.co2 === undefined ? ref : P.co2);
  return Math.max(0, Math.min(1, g0 + s * Math.log(c / ref)));
};

/* Global carbon cycle (see CO2.md): CPU ODE for atmospheric CO2 + biomass,
   advanced on a geological clock (co2Speed years per physics step). Reads the
   live climate via computeGlobals(), writes back the greenhouse factor. Runs
   once per frame from loop(); the harness calls it explicitly. */
Planet.prototype.stepCO2 = function () {
  var P = this.params;
  var g = this.computeGlobals();
  this.globals = g;
  var Tref = P.co2Tref === undefined ? 288 : P.co2Tref;
  var ref  = P.co2Ref === undefined ? 280 : P.co2Ref;
  var years = (P.co2Speed === undefined ? 20 : P.co2Speed) * Math.max(1, P.substeps | 0);
  var n = Math.max(1, Math.ceil(years / 50));   // ODE sub-steps, <=50 yr each
  var h = years / n;
  var Ca = P.co2 === undefined ? ref : P.co2;
  var Cb = P.biomass === undefined ? 400 : P.biomass;
  var landFrac = Math.max(1e-3, (g.areaTotal - g.areaOcean) / g.areaTotal);
  var suitFrac = (g.suitOcean * (P.bioOnWater === undefined ? 1 : P.bioOnWater)
                + g.suitLand  * (P.bioOnLand  === undefined ? 1 : P.bioOnLand)) / g.areaTotal;
  for (var k = 0; k < n; k++) {
    var xi = (this.seedRand() - 0.5) * 2;                              // deterministic noise
    var volc = (P.volcRate) * (1 + (P.volcVar === undefined ? 0.5 : P.volcVar) * xi);
    var weather = P.weatherRate * g.iceFreeLandFrac
                * Math.exp(P.weatherTsens * (g.landT - Tref)) * (Ca / ref);
    var ceq = ref * Math.exp((P.oceanCO2Tsens) * (g.sstMean - Tref));
    var ocean = P.oceanCO2K * (ceq - Ca);                             // + = ocean releases to air
    var npp = P.bioRate * suitFrac * (Ca / (Ca + P.bioHalf)) * Math.max(0, 1 - Cb / P.bioCap);
    var resp = P.bioResp * Cb;
    Ca += h * (volc - weather + ocean - npp + resp);
    Cb += h * (npp - resp);
    if (!(Ca > 0)) Ca = 0.1; if (Ca > 1e5) Ca = 1e5;
    if (!(Cb >= 0)) Cb = 0; if (Cb > 10 * P.bioCap) Cb = 10 * P.bioCap;
  }
  P.co2 = Ca; P.biomass = Cb;
  P.greenhouse = this.greenhouseFromCO2();
};

/* Barotropic (rigid-lid) projection — see the BARO_* shaders. Removes the
   divergent part of the depth-integrated transport so the two ocean layers
   mass-balance (div(h_top u_top) = -div(h_deep u_deep)). Runs on the final
   post-couple state in A[]; phi ping-pongs in the eta scratch textures, and the
   source velocities are snapshotted into P[1]/P[3] to avoid a feedback loop. */
Planet.prototype.projectBarotropic = function () {
  var W = this.grid.W, H = this.grid.H;
  var P = this.params;
  var gl = this.gl;

  // snapshot A[1],A[3] -> P[1],P[3]
  var cpy = this.prog.baroCopy.use();
  cpy.tex('uSrc0', this.A[1]).tex('uSrc1', this.A[3]);
  this.fullscreen('baroV', W, H);

  // b = div(U*) into eta.y; phi (.x) warm-started from texPhi
  var dv = this.prog.baroDiv.use();
  this.gridUniforms(dv);
  dv.tex('uTopS', this.A[0]).tex('uTopV', this.A[1]).tex('uDeepV', this.A[3])
    .tex('uPhiPrev', this.texPhi);
  this.fullscreen('etaA', W, H);

  // Jacobi sweeps: lap(phi) = b
  var etaT = { etaA: this.texEtaA, etaB: this.texEtaB };
  var iters = Math.max(1, (P.baroIters === undefined ? 40 : P.baroIters) | 0);
  var src = 'etaA', dst = 'etaB';
  for (var it = 0; it < iters; it++) {
    var ji = this.prog.baroJacobi.use();
    this.gridUniforms(ji);
    ji.tex('uEtaIn', etaT[src]).f('uJacobiOmega', 0.8);
    this.fullscreen(dst, W, H);
    var t = src; src = dst; dst = t;
  }

  // correct: du = grad(phi)/D applied to both layers, P[1]/P[3] -> A[1]/A[3]
  var cr = this.prog.baroCorrect.use();
  this.gridUniforms(cr);
  cr.tex('uTopS', this.A[0]).tex('uTopV', this.P[1]).tex('uDeepV', this.P[3])
    .tex('uEta', etaT[src]);
  this.fullscreen('oceanV', W, H);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
};

/* Scheme B: implicit free surface via Jacobi iteration over eta.
   Passes: predictor (A->P) -> RHS probe (P->etaA) -> Jacobi loop (etaA<->etaB)
   -> correct (P + eta_final -> B). See PLAN.md Phase 10. */
Planet.prototype.stepOceanB = function () {
  var W = this.grid.W, H = this.grid.H;
  var P = this.params;

  // 1. Predictor: advance everything except the pressure gradient. A -> P.
  var pr = this.prog.oceanPredict.use();
  this.gridUniforms(pr);
  pr.tex('uTopS', this.A[0]).tex('uTopV', this.A[1])
    .tex('uDeepS', this.A[2]).tex('uDeepV', this.A[3])
    .f('uDt', P.dt).f('uOmega', P.omegaSpin)
    .f('uNuVel', P.nuVelOcean).f('uNuT', P.nuTOcean)
    .f('uFricTop', P.fricOceanTop).f('uFricDeep', P.fricOceanDeep)
    .f('uCdBottom', P.cdBottom).f('uFricDepthRef', P.fricDepthRef)
      .f('uAlphaT', 1.7e-4).f('uBetaS', 7.8e-4)
      .f('uGravity', P.gravity)
      .f('uDrag', P.oceanDrag + P.mechanicalFric)
      .f('uSteric', P.steric).f('uStericRate', P.stericRate)
      .f('uMassSpring', P.massSpring)
      .f('uHtot', P.hTotal).f('uHref', P.hTop)
      .f('uPgfTop', P.pgfTop).f('uPgfDeepGain', P.pgfDeepGain)
      .f('uRhieChow', 0).f('uCoriCN', P.coriCN ? 1 : 0);
  this.fullscreen('P', W, H);

  // 2. RHS probe: R = eta_pred - dt*div(h*u*) from the predicted state. P -> etaA.
  var rr = this.prog.oceanRhs.use();
  this.gridUniforms(rr);
  rr.tex('uTopS', this.P[0]).tex('uTopV', this.P[1])
    .tex('uDeepS', this.P[2]).tex('uDeepV', this.P[3])
    .f('uDt', P.dt).f('uPgfTop', P.pgfTop);
  this.fullscreen('etaA', W, H);

  // 3. Jacobi loop with convergence tracking and early-exit.
  var etaT = { etaA: this.texEtaA, etaB: this.texEtaB };
  var iters = P.implicitIters | 0;
  var src = 'etaA', dst = 'etaB';
  this.residualHistory = [];
  this.lastJacobiIters = 0;
  for (var it = 0; it < iters; it++) {
    var ji = this.prog.oceanJacobi.use();
    this.gridUniforms(ji);
    ji.tex('uEtaIn', etaT[src])
      .tex('uCellC', this.texCellC)
      .f('uDt', P.dt).f('uPgfTop', P.pgfTop)
      .f('uJacobiOmega', 0.8);
    this.fullscreen(dst, W, H);
    this.lastJacobiIters = it + 1;
    if (this.trackResidual) {
      // Only when validating: read back max |residual| for early-exit + history.
      var mx = this._maxResidual(dst);
      this.residualHistory.push(mx);
      if (!(mx > 0) || mx < 1e-6) { src = dst; break; }   // converged
    }
    var t = src; src = dst; dst = t;                      // ping-pong
  }

  // 4. Correct: apply implicit eta to velocity, advect tracers, entrain. P -> B.
  var cp = this.prog.oceanCorrect.use();
  this.gridUniforms(cp);
  cp.tex('uTopS', this.P[0]).tex('uTopV', this.P[1])
    .tex('uDeepS', this.P[2]).tex('uDeepV', this.P[3])
    .tex('uEta', etaT[src])
    .f('uDt', P.dt).f('uNuT', P.nuTOcean)
      .f('uPgfTop', P.pgfTop).f('uPgfDeepGain', P.pgfDeepGain)
      .f('uAlphaT', 1.7e-4).f('uBetaS', 7.8e-4)
      .f('uGravity', P.gravity);
  this.fullscreen('dynO', W, H);
};

/* 1-fragment max-reduction of the eta texture's |residual| channel (.w). */
Planet.prototype._maxResidual = function (texName) {
  var gl = this.gl;
  var pr = this.prog.maxRed.use();
  this.gridUniforms(pr);
  pr.tex('uSrc', this[texName]).i('uCount', this.grid.V);
  this.fullscreen('maxRes', 1, 1);
  var buf = new Float32Array(4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.maxRes);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, buf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return buf[0];
};

/* Bind a pool's two-sublayer velocity uniforms onto the current program. The
   advection pass (STATE_FS) uses layerVel(cell, layer) so each particle moves
   with its current sublayer's field, honouring time-averaging / even-out-speed
   / gain. */
Planet.prototype.bindFlow = function (p, pool) {
  var P = this.params;
  var c = pool.cfg;
  var useSmooth = (P.flowAvg === undefined ? 1 : P.flowAvg) > 0.5 ? 1.0 : 0.0;
  if (!this.smoothInit) useSmooth = 0.0;   // no EMA yet -> fall back to raw field
  p.tex('uVel0', this.A[c.vel[0]]).tex('uVel1', this.A[c.vel[1]])
    .tex('uSmooth0', this.smoothTex(c.smooth[0])).tex('uSmooth1', this.smoothTex(c.smooth[1]))
    .f('uMul0', c.mul[0]).f('uMul1', c.mul[1])
    .f('uUseSmooth', useSmooth)
    .f('uNormalize', P.flowUniform ? 1.0 : 0.0)
    .f('uBaseSpeed', 1.0)
    .f('uGain', P.flowGain === undefined ? 1.0 : P.flowGain);
};

/* Advance both particle pools one frame: STATE_FS moves each head, ages it, and
   (when enabled) moves it between sublayers with probability proportional to
   the vertical mass flux; TRAIL_FS shifts the history conveyor. */
Planet.prototype.stepFlow = function (dt) {
  var gl = this.gl;
  var P = this.params;
  var life = (P.flowLife === undefined ? 20 : P.flowLife) * 86400;   // days -> sim seconds
  var move = (P.flowRecycle === undefined ? 1 : P.flowRecycle) > 0.5 ? 1.0 : 0.0;
  var transK = 2.0 * (P.flowMix === undefined ? 1.0 : P.flowMix);
  for (var i = 0; i < this.pools.length; i++) {
    var pool = this.pools[i], c = pool.cfg;
    var cur = pool.idx, nxt = 1 - pool.idx;
    // 1. STATE: head position, sublayer transitions, life phase.
    var ps = this.prog.state.use();
    this.gridUniforms(ps);
    ps.tex('uTrail', pool.trail[cur]).tex('uState', pool.state[cur])
      .tex('uLookup', this.texLookup).tex('uVFlow', this.texVFlow)
      .iv2('uPDim', this.PW, this.PH)
      .f('uDt', dt).f('uLife', life).f('uRadius', this.params.planetRadius)
      .f('uSeed', this.seedRand() * 1000)
      .f('uMove', move).f('uTransK', transK).f('uMaxP', 0.25)
      .f('uVScale', c.wScale).f('uFluxSign', c.fluxSign).i('uWChan', c.wChan);
    this.bindFlow(ps, pool);
    this.fullscreen('st' + i + (nxt === 1 ? 'b' : 'a'), this.PW, this.PH);
    // 2. TRAIL: shift the conveyor, writing the new head (+sublayer) into slot 0.
    var pt = this.prog.trail.use();
    pt.tex('uTrail', pool.trail[cur]).tex('uState', pool.state[nxt])
      .iv2('uPDim', this.PW, this.PH).i('uSlots', this.PT);
    this.fullscreen('tr' + i + (nxt === 1 ? 'b' : 'a'), this.PW, this.PH * this.PT);
    pool.idx = nxt;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
};

/* Recompute the vertical-flow field (interface up/down mass flux) for both the
   ocean and the air layers. Cheap: one FV divergence pass over the grid. */
Planet.prototype.stepVFlow = function () {
  var gl = this.gl;
  var p = this.prog.vflow.use();
  this.gridUniforms(p);
  p.tex('uTopS', this.A[0]).tex('uTopV', this.A[1]).tex('uDeepV', this.A[3]).tex('uLoA', this.A[4]);
  this.fullscreen('vflow', this.grid.W, this.grid.H);
  this.vflowInit = true;
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
    .tex('uVFlow', this.texVFlow)
    .tex('uIce', this.iceTex())
    .m4('uMVP', mvp)
    .v3('uSun', sun[0], sun[1], sun[2]).v3('uEye', eye[0], eye[1], eye[2])
    .f('uShowLand', P.showLand).f('uNight', P.nightShading).f('uRelief', P.relief)
    .f('uIceOn', P.iceOn === undefined ? 0 : P.iceOn)
    .f('uIceShow', (P.iceOverlay === undefined ? 1 : P.iceOverlay) * (P.iceOn === undefined ? 0 : P.iceOn));
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

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);
  this.drawTracers(mvp, 0.0, 2.0 * Math.min(2, dpr));
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.enable(gl.CULL_FACE);
  gl.bindVertexArray(null);
};

/* Draw both particle pools as history trails (or dots). Each particle is
   coloured by its current sublayer and shown only if that sublayer's streamline
   bit is set, so the existing per-layer checkboxes still select what's visible
   while a single pool draws the descending/ascending overturning. */
Planet.prototype.drawTracers = function (mvp, equirect, psz) {
  var gl = this.gl;
  var P = this.params;
  var dots = (P.flowLines === undefined ? 1 : P.flowLines) < 0.5;
  var K = Math.max(2, Math.min(this.PT, P.flowSegs | 0));
  var n = this.PW * this.PH;
  var mask = P.streamline | 0;
  for (var pi = 0; pi < this.pools.length; pi++) {
    var pool = this.pools[pi], c = pool.cfg;
    // skip the whole pool if neither of its sublayers is enabled
    if ((((mask >> c.idx[0]) & 1) | ((mask >> c.idx[1]) & 1)) === 0) continue;
    var pp = this.prog.points.use();
    this.gridUniforms(pp);
    pp.tex('uTrail', pool.trail[pool.idx]).tex('uState', pool.state[pool.idx])
      .iv2('uPDim', this.PW, this.PH).i('uSlots', this.PT).i('uDrawSlots', K)
      .f('uEquirect', equirect).f('uRadius', this.params.planetRadius)
      .f('uAsPoints', dots ? 1 : 0).f('uPointSize', psz)
      .v3('uColor0', c.col[0][0], c.col[0][1], c.col[0][2])
      .v3('uColor1', c.col[1][0], c.col[1][1], c.col[1][2])
      .i('uMask', mask).i('uIdx0', c.idx[0]).i('uIdx1', c.idx[1]);
    if (mvp) pp.m4('uMVP', mvp);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(dots ? gl.POINTS : gl.LINES, 0, dots ? n : n * 2 * (K - 1));
  }
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
    .tex('uLookup', this.texLookup).tex('uVFlow', this.texVFlow)
    .tex('uIce', this.iceTex())
    .v3('uSun', sun[0], sun[1], sun[2])
    .f('uShowLand', P.showLand).f('uNight', P.nightShading)
    .f('uIceOn', P.iceOn === undefined ? 0 : P.iceOn)
    .f('uIceShow', (P.iceOverlay === undefined ? 1 : P.iceOverlay) * (P.iceOn === undefined ? 0 : P.iceOn));
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

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.depthMask(false);
  this.drawTracers(null, 1.0, 2.0 * Math.min(2, window.devicePixelRatio || 1));
  gl.depthMask(true);
  gl.disable(gl.BLEND);
};

Planet.prototype.loop = function () {
  if (this.disposed) return;
  this.raf = requestAnimationFrame(this._loop);
  var P = this.params;
  if (P.running) {
    if (P.co2On > 0.5) this.stepCO2();
    for (var i = 0; i < P.substeps; i++) this.step();
    this.stepSmooth();
    this.stepVFlow();
    this.stepFlow(P.dt * P.substeps);
  } else if (!this.vflowInit) {
    this.stepVFlow();       // ensure the up/down map is populated when paused
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
      co2On: P.co2On > 0.5, co2: P.co2, biomass: P.biomass, greenhouse: P.greenhouse,
      meanT: this.globals ? this.globals.meanT : null,
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
