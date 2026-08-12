/* shader.js - all GLSL program sources (WebGL2 / GLSL ES 3.00) */
var SHADER_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;
/* Combined Crank-Nicolson Coriolis + implicit linear friction update. Shared
   by every dynamics program (ocean top/deep, air, init, couple) so the body
   lives in exactly one place. c = dt*f/2; c = 0 reduces to the plain
   implicit-friction form. NOTE: c == 0 must return EXACTLY the legacy
   expression (v0 + dt*acc)/D so the explicit-friction path is preserved. */
var CORI_FRIC_GLSL = `vec2 coriFric(vec2 v0, vec2 acc, float dt, float fric, float c){
  float D = 1.0 + dt*fric;
  if(c == 0.0) return (v0 + dt*acc)/D;
  float P = v0.x + dt*acc.x - c*v0.y;
  float Q = v0.y + dt*acc.y + c*v0.x;
  float den = D*D + c*c;
  return vec2(D*P - c*Q, D*Q + c*P)/den;
}`;


// index = uMode; value = GLSL expression for `float v`, referencing the per-cell
// textures wt/la/lb/ha/hb/wd already in scope. Drives PER-MODE source compilation,
// so there is no runtime branch on mode.
var MODE_FIELDS = [
  '(la.z-238.0)/72.0',                       // 0  low-air T
  '(wt.x-260.0)/50.0',                       // 1  ocean-surface T
  '(la.w-101325.0)/2600.0*0.5+0.5',          // 2  low-air P
  'lb.x/0.022',                              // 3  humidity
  'length(la.xy)/34.0',                      // 4  wind speed
  'length(wt.yz)/1.1',                        // 5  ocean current
  'hb.y/1.6',                                // 6  rain
  '(wt.w-33.0)/4.0',                         // 7  salinity
  '(wd.x-272.0)/16.0',                       // 8  deep-ocean T
  '(ha.z-215.0)/45.0',                       // 9  high-air T
  '(ha.w-45000.0)/4000.0*0.5+0.5',           // 10 high-air P
  'hb.x/0.022',                              // 11 high-air humidity
  'length(ha.xy)/34.0',                      // 12 high-air speed
  'length(wd.yz)/0.25',                      // 13 deep-ocean speed
  '(wd.w-33.0)/4.0',                         // 14 deep-ocean salinity
  '(ht-50.0)/20.0',                        // 15 top-layer thickness h_top (m)
  'Dc/5000.0',                             // 16 ocean depth D (m)
  '(ht-hRc)/8.0*0.5+0.5',                  // 17 interface displacement eta (m)
];
// modes that use magnitude (dark-background) coloring; palette-color fields excluded
var MODE_MAG = { 3:1, 4:1, 5:1, 6:1, 11:1, 12:1, 13:1, 16:1 };
function modeValueSrc(m) {
  return 'float v = ' + (MODE_FIELDS[m] != null ? MODE_FIELDS[m] : MODE_FIELDS[9]) + ';';
}
/* Same per-mode expression, wrapped as a function of an arbitrary cell index so
   the globe vertex shader can also sample its 1-ring neighbours and pre-blend
   them (softens hex faceting without a per-fragment nearest-cell lookup). */
/* The ocean state lives in 4 textures now (topS/topV/deepS/deepV); the mode
   expressions above keep using the old compact `wt`/`wd` vec4 view
   (T, u, v, S) which we simply reassemble here, plus `ht` = h_top. */
var OCEAN_UNPACK = `
  vec4 _tS = texelFetch(uTopS , cTex(cell),0);
  vec4 _tV = texelFetch(uTopV , cTex(cell),0);
  vec4 _dS = texelFetch(uDeepS, cTex(cell),0);
  vec4 _dV = texelFetch(uDeepV, cTex(cell),0);
  vec4 wt = vec4(_tS.y, _tV.xy, _tS.z);
  vec4 wd = vec4(_dS.x, _dV.xy, _dS.y);
  float ht = _tS.x;
  vec4 _cC = texelFetch(uCellC, cTex(cell),0);
  float Dc  = _cC.x;   // total ocean depth at this cell (m)
  float hRc = _cC.y;   // reference top-layer thickness (m)
`;
function modeSampleFnSrc(m) {
  return 'float sampleVal(int cell){\n' +
    OCEAN_UNPACK +
    '  vec4 la = texelFetch(uLoA,  cTex(cell),0);\n' +
    '  vec4 lb = texelFetch(uLoB,  cTex(cell),0);\n' +
    '  vec4 ha = texelFetch(uHiA,  cTex(cell),0);\n' +
    '  vec4 hb = texelFetch(uHiB,  cTex(cell),0);\n' +
    '  ' + modeValueSrc(m) + '\n' +
    '  return v;\n' +
    '}';
}
function modeMagSrc(m) {
  return MODE_MAG[m] ? 'base = mix(vec3(0.02,0.03,0.07), base, pow(vVal,0.7));' : '';
}
/* Modes 16/17 show time-invariant geometry (bathymetry, interface displacement)
   rather than a lit surface field. Shading them with the day/night terminator
   hides half the map for no reason, so they render unlit with land as flat
   grey so the coastline still reads. */
var MODE_GEOM = { 16: 1, 17: 1 };
function modeLitSrc(m, expr) {
  return MODE_GEOM[m] ? 'lit = 1.0;' : '';
}
function modeLandSrc(m) {
  return MODE_GEOM[m]
    ? 'base = mix(base, vec3(0.16,0.17,0.20), vLand);'
    : 'base = mix(base, base*vec3(0.72,0.88,0.62)+vec3(0.10,0.09,0.02), uShowLand*vLand*0.45);';
}

var SHADER_COMMON = `
uniform ivec2 uDim;          // W, H of the cell texture
uniform int   uCount;        // number of real cells (V)
uniform sampler2D uCellA;    // pos.xyz , area
uniform sampler2D uCellB;    // east.xyz, land
uniform sampler2D uCellC;    // D (total depth), hRef, bedElev, coastDist
uniform sampler2D uNbrA;     // idx , edgeLen , dist , valid
uniform sampler2D uNbrB;     // nx , ny , rotA , rotB

ivec2 cTex(int i){ int y = i / uDim.x; return ivec2(i - y*uDim.x, y); }
ivec2 nTex(int i,int k){ int y = i / uDim.x; return ivec2(i - y*uDim.x, y + k*uDim.y); }

/* ---- per-cell ocean geometry -------------------------------------------
   Bathymetry is STATIC, so it lives in a texture built once on the CPU
   rather than being recomputed per step. */
uniform float uHmin;         // nominal minimum layer thickness (legacy 40.0)

vec4  cellC(int i)   { return texelFetch(uCellC, cTex(i), 0); }
float cellD(int i)   { return texelFetch(uCellC, cTex(i), 0).x; }   // total depth
float cellHref(int i){ return texelFetch(uCellC, cTex(i), 0).y; }   // reference h_top

/* Safe clamp range for the top layer given a column of depth D.
   The old code clamped to [40, D-40] with a hard-coded 40. On a 30 m shelf
   that range is INVERTED (40 > -10) and clamp() then returns the upper bound,
   silently producing a negative or nonsensical thickness. Scaling the floor
   with the column depth keeps lo < hi for every D. */
void hLimits(float D, out float lo, out float hi){
  lo = min(uHmin, 0.25 * D);
  hi = max(D - lo, lo + 1.0);
}
float clampH(float h, float D){
  float lo, hi; hLimits(D, lo, hi);
  return clamp(h, lo, hi);
}

/* ---- stratification ----------------------------------------------------
   Bulk Richardson number of the interface: the ratio of the buoyancy that
   resists overturning to the kinetic energy available in the shear.
     Ri = g' h / |du|^2
   Ri >> 1 : strongly stratified, shear cannot overturn the interface
   Ri -> 0 : shear dominates, layers exchange freely
   Ri <  0 : dense water over light water -> convectively unstable */
uniform float uRiCrit;   // Ri above which exchange is considered suppressed
uniform float uMixConv;  // mixing multiplier under convective instability

float bulkRi(float gp, float h, vec2 dv){
  return gp*max(h, 1.0)/max(dot(dv, dv), 1e-8);
}
/* Pacanowski-Philander style suppression, normalised so that Ri == uRiCrit
   maps to 1.0. That keeps the DEFAULT strength of every exchange it scales
   at the value the model was originally tuned for, so this introduces a
   stratification DEPENDENCE without silently rescaling the climate. */
float stratMix(float Ri){
  if(Ri < 0.0) return uMixConv;
  float r = 1.0 + 5.0*Ri/max(uRiCrit, 1e-4);
  float n = 1.0 + 5.0;
  return min(uMixConv, (n*n)/(r*r));
}

vec2 xfer(vec2 v, float ra, float rb){ return vec2(ra*v.x - rb*v.y, rb*v.x + ra*v.y); }

float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

float qsat(float T, float P){
  float es = 611.2*exp(17.67*(T-273.15)/max(T-29.65, 20.0));
  return clamp(0.622*es/max(P-0.378*es, 100.0), 0.0, 0.08);
}
`;

var QUAD_VS = SHADER_HEAD + `
void main(){
  vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

var EQUI_VS = SHADER_HEAD + `
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
  vUv = p;   // on-screen this spans [0,1]x[0,1] (full lon/lat), matching MAP_VS
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

function EQUI_FS(m) {
return SHADER_HEAD + SHADER_COMMON + `
uniform sampler2D uTopS, uTopV, uDeepS, uDeepV, uLoA, uLoB, uHiA, uHiB, uLookup;
uniform vec3  uSun;
uniform float uShowLand, uNight;
in vec2 vUv;
out vec4 o;
vec3 pal(float t){
  t = clamp(t,0.0,1.0);
  vec3 c0=vec3(0.05,0.02,0.25), c1=vec3(0.05,0.35,0.75), c2=vec3(0.10,0.75,0.65),
       c3=vec3(0.85,0.85,0.25), c4=vec3(0.90,0.35,0.10), c5=vec3(0.65,0.05,0.12);
  if(t<0.2) return mix(c0,c1,t/0.2);
  if(t<0.4) return mix(c1,c2,(t-0.2)/0.2);
  if(t<0.6) return mix(c2,c3,(t-0.4)/0.2);
  if(t<0.8) return mix(c3,c4,(t-0.6)/0.2);
  return mix(c4,c5,(t-0.8)/0.2);
}
void main(){
  vec2 uv = vUv;
  int cell = int(texture(uLookup, uv).r + 0.5);
  if(cell < 0 || cell >= uCount){ o = vec4(0.02,0.03,0.07,1.0); return; }

${OCEAN_UNPACK}
  vec4 la = texelFetch(uLoA,  cTex(cell),0);
  vec4 lb = texelFetch(uLoB,  cTex(cell),0);
  vec4 ha = texelFetch(uHiA,  cTex(cell),0);
  vec4 hb = texelFetch(uHiB,  cTex(cell),0);
  vec4 ca = texelFetch(uCellA,cTex(cell),0);
  vec4 cb = texelFetch(uCellB,cTex(cell),0);

${modeValueSrc(m)}
  float vVal = clamp(v, 0.0, 1.0);
  float vLand = cb.w;

  vec3 base = pal(vVal);
${modeMagSrc(m)}
${modeLandSrc(m)}

  // day/night uses the real cell normal (blocky, crisp) — not a smooth reconstruction
  vec3 n = normalize(ca.xyz);
  float d = max(0.0, dot(n, uSun));
  float lit = mix(1.0, 0.16 + 0.9*d, uNight);
${modeLitSrc(m)}

  vec3 col = base * lit;
  o = vec4(col, 1.0);
}`;
}

var EQUI_CLOUD_FS = SHADER_HEAD + SHADER_COMMON + `
// NOTE: uCellA/uCellB/uNbrA/uNbrB are already declared by SHADER_COMMON.
// Re-declaring uCellA here was a compile error ('redefinition') that silently
// disabled the cloud deck in equirect/map mode.
uniform sampler2D uLookup, uLoB, uHiB;
uniform vec3 uSun;
uniform float uNight;
in vec2 vUv;
out vec4 o;
void main(){
  int cell = int(texture(uLookup, vUv).r + 0.5);
  if(cell < 0 || cell >= uCount){ discard; }
  vec3 n = normalize(texelFetch(uCellA, cTex(cell), 0).xyz);
  float cloud = clamp(texelFetch(uLoB, cTex(cell), 0).y, 0.0, 1.0);
  float rain  = clamp(texelFetch(uHiB, cTex(cell), 0).y, 0.0, 2.0);
  float a = clamp(cloud*0.9 + rain*0.35, 0.0, 1.0);
  if(a < 0.02) discard;
  float d = max(0.0, dot(n, uSun));
  float lit = mix(1.0, 0.22 + 0.85*d, uNight);
  vec3 c = mix(vec3(1.0), vec3(0.45,0.5,0.62), clamp(rain*0.5, 0.0, 0.75));
  o = vec4(c*lit, a*0.85);
}`;

/* ---------------------------------------------------------------------------
   OCEAN DYNAMICS - two layers, mass/momentum conserving.

   Texture layout (4 RGBA32F, ping-ponged):
     topS  = (h_top, T_top, S_top, _)     surface scalars + thickness
     topV  = (u_top, v_top, _, _)         surface velocity (local tangent basis)
     deepS = (T_deep, S_deep, _, _)       abyssal scalars
     deepV = (u_deep, v_deep, _, _)       abyssal velocity
   h_deep = D - h_top is DERIVED (D = per-cell depth from uCellC), so the
   total ocean volume is fixed by
   construction and only the interface between the two layers moves.

   * MASS: h_top obeys the flux-form continuity equation
       dh/dt + div(h*u) = S
     the discrete div(h*u) reuses exactly the same face-normal velocity that
     the momentum/tracer updates use, so horizontal transport creates no mass.
   * MOMENTUM: inter-layer stress tau = r*|du|*du is applied equally and
     oppositely with inverse-column-mass weighting, so
       d(rho*h_top*u_top + rho*h_deep*u_deep)/dt = -tau + tau = 0.
   * The top layer feels -g*grad(h_top); the deep layer feels +g'*grad(h_top)
     with g' the reduced gravity from the density contrast, which closes the
     overturning loop into a genuine return limb.
--------------------------------------------------------------------------- */
var OCEAN_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oTopS;
layout(location=1) out vec4 oTopV;
layout(location=2) out vec4 oDeepS;
layout(location=3) out vec4 oDeepV;

uniform sampler2D uTopS, uTopV, uDeepS, uDeepV;
uniform float uDt, uOmega, uNuVel, uNuT, uFricTop, uFricDeep, uAlphaT, uBetaS;
uniform float uCdBottom;     // quadratic bottom-drag coefficient [-]
uniform float uFricDepthRef; // reference depth for the linear friction taper [m]
uniform float uDrag;         // effective inter-layer drag coeff (kg/m^3/s)
uniform float uSteric, uStericRate; // buoyancy -> equilibrium thickness, and its rate
uniform float uMassSpring;   // weak global mass correction (1/s)
uniform float uHtot, uHref;  // legacy global depth / reference thickness (m)
                             // (superseded per-cell by uCellC; kept for INIT)
uniform float uPgfTop;       // pressure-gradient gain, top layer  [m/s^2 per m]
uniform float uPgfDeepGain;  // multiplier on the deep layer's g'  [-]
uniform float uRhieChow;     // Rhie-Chow face-velocity smoothing  [-] 0 = legacy
uniform float uFbStab;       // forward-backward gravity-wave stabiliser [-] 0 = legacy
uniform float uCoriCN;       // 1 = Crank-Nicolson Coriolis, 0 = legacy explicit
uniform int   uScheme;       // 0 = current (explicit), 1 = A (decoupled heightmap).
                             // Scheme 2 (B, implicit) does not use this program.

// Buoyancy anomaly of a layer: positive = warm/fresh = light.
float buoy(float T, float S){ return uAlphaT*(T-283.0) - uBetaS*(S-35.0); }

// Reduced gravity from the instantaneous T/S contrast between the layers.
float gPrime(float Tt, float St, float Td, float Sd){
  float rhoT = 1027.0*(1.0 - uAlphaT*(Tt-283.0) + uBetaS*(St-35.0));
  float rhoD = 1027.0*(1.0 - uAlphaT*(Td-283.0) + uBetaS*(Sd-35.0));
  return 9.81*clamp((rhoD - rhoT)/rhoD, -1.0, 1.0);
}

${CORI_FRIC_GLSL}

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  if(cell >= uCount){
    oTopS = vec4(0.0); oTopV = vec4(0.0); oDeepS = vec4(0.0); oDeepV = vec4(0.0);
    return;
  }
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz), e1 = cb.xyz, e2 = cross(e1, n);
  float area = ca.w, land = cb.w;

  vec4  ts0 = texelFetch(uTopS , cTex(cell), 0);   // (h, T, S, _)
  vec4  tv0 = texelFetch(uTopV , cTex(cell), 0);   // (u, v, grad(eta).x, grad(eta).y)
  vec2  vt0 = tv0.xy;
  /* .zw carry LAST step's cell-centred grad(eta) in this cell's local basis.
     Storing it costs nothing (the channels were unused) and lets the
     Rhie-Chow correction below compare a compact face gradient against the
     averaged cell gradient without a second pass over the neighbours. */
  vec2  gPrev0 = tv0.zw;
  vec4  ds0 = texelFetch(uDeepS, cTex(cell), 0);   // (T, S, _, _)
  vec2  vd0 = texelFetch(uDeepV, cTex(cell), 0).xy;
  float h0  = ts0.x;
  /* Per-cell ocean geometry. Dep replaces the single global uHtot so the
     column depth, and hence the deep-layer thickness, varies with the sea
     floor. eta0 is the interface displacement relative to rest (see the
     grad(eta) note in the neighbour loop). */
  float Dep  = cellD(cell);
  float hRef0= cellHref(cell);
  float hd0  = Dep - h0;
  float eta0 = h0 - hRef0;
  vec2  trT0 = ts0.yz;          // (T_top,  S_top)
  vec2  trD0 = ds0.xy;          // (T_deep, S_deep)

  float gp = gPrime(ts0.y, ts0.z, ds0.x, ds0.y);

  float divF = 0.0;             // div(h_top*u_top): the mass flux
  float divT = 0.0, divD = 0.0; // div(u) per layer (advective-form correction)
  vec2  gradH = vec2(0.0);      // grad(eta), eta = h_top - hRef
  float lapEta = 0.0;           // lap(eta), for the forward-backward stabiliser
  float mDif   = 0.0;           // sum(L/d): discrete Laplacian metric ~ k_max^2*area
  vec2  lapVt = vec2(0.0), lapVd = vec2(0.0);
  vec2  advVt = vec2(0.0), advVd = vec2(0.0);
  vec2  lapTt = vec2(0.0), lapTd = vec2(0.0);
  vec2  advTt = vec2(0.0), advTd = vec2(0.0);

  for(int k=0;k<6;k++){
    vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
    if(na.w < 0.5) continue;                 // pentagon: only 5 neighbours
    int   j = int(na.x);
    float L = na.y;                          // Voronoi edge length [m]
    float d = na.z;                          // centre distance     [m]
    vec4  nb = texelFetch(uNbrB, nTex(cell,k), 0);
    vec2  nrm = nb.xy;                       // unit outward normal (local basis)

    vec4  tsj = texelFetch(uTopS , cTex(j), 0);
    vec4  dsj = texelFetch(uDeepS, cTex(j), 0);
    vec2  vtj = texelFetch(uTopV , cTex(j), 0).xy;
    vec2  vdj = texelFetch(uDeepV, cTex(j), 0).xy;
    float landj = texelFetch(uCellB, cTex(j), 0).w;
    float wet = (1.0-landj)*(1.0-land);      // no flow through coastlines

    vtj = xfer(vtj, nb.z, nb.w) * (1.0-landj);
    vdj = xfer(vdj, nb.z, nb.w) * (1.0-landj);

    /* Face-normal velocities -- the SAME quantities used by every operator
       below, so mass, tracer and momentum transport stay consistent.

       RHIE-CHOW / odd-even decoupling.  The plain average 0.5*(v0+vj).n is
       BLIND to a grid-scale checkerboard: for v0 = +a, vj = -a it returns
       exactly 0, so an odd-even oscillation generates no mass divergence,
       feels no pressure response, and is never damped.  That null space is
       the reason the noise in the polar caps survived even dt = 5 s -- it is
       a defect of the collocated (A-grid) SPATIAL stencil, not a CFL limit,
       so shrinking dt cannot touch it.

       The standard cure is to build the face velocity from a COMPACT
       face-centred pressure gradient instead of an averaged cell-centred
       one.  The two agree to 2nd order for smooth fields and differ only for
       grid-scale modes, so the correction below is invisible to the resolved
       flow but gives the checkerboard the pressure feedback it was missing.
       gPrev is lagged one step, which is normal practice and keeps this to a
       single pass.  uRhieChow = 0 restores the legacy stencil exactly. */
    float unT = 0.5*dot(vt0+vtj, nrm)*wet;
    float unD = 0.5*dot(vd0+vdj, nrm)*wet;
    vec2  gPrevJ = xfer(texelFetch(uTopV, cTex(j), 0).zw, nb.z, nb.w);
    float dEtaF  = (tsj.x - h0) - (cellHref(j) - hRef0);
    float gComp  = dEtaF/d;                        // compact face gradient
    float gAvg   = 0.5*dot(gPrev0 + gPrevJ, nrm);  // averaged cell gradient
    unT -= uRhieChow*uDt*uPgfTop*(gComp - gAvg)*wet;

    // --- CONTINUITY: mass flux through this face = L * h_face * u_n --------
    float hFace = 0.5*(h0 + tsj.x);
    divF += L*hFace*unT;
    divT += L*unT;
    divD += L*unD;

    /* Interface-DISPLACEMENT gradient (Gauss), drives both layers with
       opposite signs.

       This must be grad(eta) with eta = h_top - hRef, NOT grad(h_top).
       h_top is a sigma-like thickness: where the reference layer thickness
       varies (shallow shelf vs deep basin) a RESTING ocean already has a
       non-zero grad(h_top), and using it directly injects a permanent,
       purely topographic pressure gradient -- the classic sigma-coordinate
       PGF error. With the barotropic gain of ~9.81 that is not a small
       error: a 200 m step over 2000 km geostrophically balances a ~9.8 m/s
       jet, which the 2.99 m/s speed clamp would then hide as a permanent
       fake coastal current.

       Subtracting the per-cell reference removes the resting state exactly.

       Grouped as (h_j - h_0) - (hRef_j - hRef_0) rather than
       (h_j - hRef_j) - (h_0 - hRef_0): the two agree in exact arithmetic, but
       only the first makes the reference term vanish EXACTLY in float32 when
       hRef is uniform, so a flat slab reproduces the original bit for bit
       instead of drifting by rounding. */
    gradH += L*0.5*dEtaF*nrm*wet;
    /* lap(eta) via the same Gauss/FV stencil, and the metric sum(L/d)/area
       that converts it into the local (c*k*dt)^2 stability number below. */
    lapEta += (L/d)*dEtaF*wet;
    mDif   += (L/d)*wet;

    lapVt += (L/d)*(vtj-vt0)*wet;
    lapVd += (L/d)*(vdj-vd0)*wet;

    vec2 trTj = tsj.yz, trDj = dsj.xy;
    lapTt += (L/d)*(trTj-trT0);
    lapTd += (L/d)*(trDj-trD0);

    float wT = unT > 0.0 ? 0.0 : 1.0;        // 1st order upwind
    float wD = unD > 0.0 ? 0.0 : 1.0;
    advTt += L*unT*mix(trT0, trTj, wT);
    advTd += L*unD*mix(trD0, trDj, wD);
    advVt += L*unT*mix(vt0,  vtj,  wT);
    advVd += L*unD*mix(vd0,  vdj,  wD);
  }

  float ia = 1.0/area;
  divF *= ia; divT *= ia; divD *= ia; gradH *= ia; lapEta *= ia; mDif *= ia;
  lapVt *= ia; lapVd *= ia; advVt *= ia; advVd *= ia;
  lapTt *= ia; lapTd *= ia; advTt *= ia; advTd *= ia;

  // ---- MASS: dh/dt + div(h*u) = S ----------------------------------------
  //  S has two parts, both written as relaxations so they cannot run away:
  //   * steric: light (warm/fresh) water expands, so the equilibrium top-layer
  //     thickness is Href + uSteric*buoy. Relaxing h toward it at uStericRate
  //     is what converts the temperature/salinity field into a sea-surface
  //     height field, i.e. it is the thermohaline DRIVE of the circulation.
  //     It is anomaly-shaped (zero mean to first order), so it moves the
  //     interface around without a systematic volume trend.
  //   * uMassSpring: a tiny global correction that removes any residual drift
  //     of the flux-form integrator + surface forcing.
  //     Both relaxation targets are the PER-CELL reference thickness: a
  //     shelf column must relax toward its own shallow rest state, not toward
  //     a basin-wide constant that may exceed the local water depth.
  float hEq = hRef0 + uSteric*buoy(ts0.y, ts0.z);
  /* ---- FORWARD-BACKWARD GRAVITY-WAVE STABILISATION ---------------------
     (h_top, u_top) form an oscillator: linearised about a rest thickness H,
         eta_t = -H*div(u),   u_t = -g*grad(eta),   c = sqrt(g*H).
     Both halves are stepped explicitly (h1 below uses the old u, accT further
     down uses the old eta), and forward Euler on an oscillator amplifies by
     |g| = sqrt(1 + (c*k*dt)^2) > 1 at EVERY dt: there is no stable timestep,
     only a slow one. To a fixed physical time the log-amplitude grows like
     T*c^2*k^2*dt/2, i.e. linearly in dt and as 1/dx^2. That is precisely the
     reported behaviour - quiet at L5/small dt, divergent at L6-L7, and ~4x
     faster when hTop is quadrupled (c^2 = g*H), while being nearly
     independent of the sea-floor depth D.

     Forward-BACKWARD ordering fixes it: advance u with the old eta, then
     advance eta with the NEW u. Substituting u1 into the mass equation,
         eta1 = eta0 - dt*H*div(u0) + dt^2*g*H*lap(eta0),
     so the entire scheme costs one extra term built from lap(eta) - a SCALAR
     Laplacian available from the neighbour values already fetched above, with
     no second pass and no wider stencil.

     Note this deliberately acts on eta and never on u, so the rotational
     (geostrophic/gyre) flow is untouched; only the divergent gravity-wave
     mode, which is the one going unstable, is affected. An equivalent
     momentum-side form (dt^2*g*H*lap(u)) was tried first and rejected: lap(u)
     equals grad(div u) only for curl-free flow, so it also damped the gyres
     and cost 30-44% of mean surface speed.

     uFbStab = 0 restores the plain explicit scheme bit for bit. */
  /* Scale the correction by the LOCAL stability number rather than applying
     it uniformly. mDif = sum(L/d)/area is the diagonal of the discrete
     Laplacian, so nu2 = dt^2*g*H*mDif is (c*k_grid*dt)^2 at the grid scale:
     it is ~0.02 at L5/dt=120 (already stable, so almost nothing is applied)
     and ~1 where the scheme actually diverges. Saturating it at 1 keeps the
     correction from exceeding the term it is stabilising - without this the
     coefficient over-damps the fine grids hardest, which is backwards: a
     fixed fbStab=0.5 cost 10% of mean surface speed at L5 but 55% at L7. */
  float nu2 = uFbStab*uDt*uDt*uPgfTop*h0*mDif;
  float fbGain = nu2/(1.0 + nu2);        // -> 0 when stable, -> 1 when stiff
  /* Scheme A (uScheme==1) drops the fast div(h*u) transport from the thickness
     continuity entirely. With uScheme==0 this multiplies divF by exactly 1.0, so
     the arithmetic path is byte-identical to the original (divF*1.0 == divF in
     float32). Scheme A still accumulates divF (unused) and leaves the momentum
     pressure-gradient pointing at the slow steric/E-P signal, so the two-way
     h<->u wave-formation closure cannot close and no gravity wave can grow. */
  float h1 = h0 - uDt*divF*(uScheme==1?0.0:1.0)
                 + fbGain*uDt*uDt*uPgfTop*h0*lapEta
                 - uDt*uStericRate*(h0 - hEq)
                 - uDt*uMassSpring*(h0 - hRef0);
  /* Depth-aware clamp: the old fixed [40, uHtot-40] window inverts once the
     column is shallower than 80 m. hLimits() scales the floor with D. */
  h1 = clampH(h1, Dep);
  if(isnan(h1)) h1 = h0;
  float hd1 = Dep - h1;

  // ---- MOMENTUM ----------------------------------------------------------
  // top:  -uPgfTop      *grad(eta)  (flow away from a thick/warm column)
  // deep: +uPgfDeepGain*g'*grad(eta) (opposite sign -> return limb)
  //
  // uPgfTop defaults to 9.81. Strictly, a 1.5-layer reduced-gravity model
  // would use g' (~0.02) here; the full-g value acts as a stand-in for the
  // barotropic/free-surface pressure this rigid-lid model does not carry, and
  // is what gives the surface currents realistic magnitudes. It is now a
  // uniform rather than a literal so it can be retuned without editing GLSL.
  vec2 accT = -uPgfTop*gradH + uNuVel*lapVt - advVt + vt0*divT;
  vec2 accD = +uPgfDeepGain*gp*gradH + uNuVel*lapVd - advVd + vd0*divD;


  // inter-layer stress, EQUAL AND OPPOSITE, inverse-column-mass weighted:
  //   d(rho*h_top*u_top + rho*h_deep*u_deep)/dt = -tau + tau = 0
  /* Interfacial stress. A strongly stratified interface resists shear-driven
     momentum exchange, so the coupling between the layers is scaled by the
     same Richardson suppression used for the tracer exchange.

     The 0.1 floor is deliberate: uDrag carries oceanDrag + mechanicalFric,
     and mechanicalFric is by definition the stratification-INDEPENDENT part,
     so it must survive even a perfectly stratified interface. */
  vec2  dv  = vt0 - vd0;
  float hLo, hHi; hLimits(Dep, hLo, hHi);
  float dragStrat = 0.1 + 0.9*min(1.0, stratMix(bulkRi(gp, h1, dv)));
  vec2  tau = uDrag*dragStrat*length(dv)*dv;        // N/m^2
  accT -= tau/(1027.0*max(h1 , hLo));
  accD += tau/(1027.0*max(hd1, hLo));

  /* Coriolis.  Projecting the real 3-D cross product onto the tangent plane
     leaves exactly the traditional in-plane rotation at rate
         f = 2*Omega*n.y        (n.y = sin(latitude))
     because the tangential part of Omega crosses into the surface normal and
     drops out of the projection.

     Evaluating that rotation EXPLICITLY (a += dt*f*perp(v0)) is unstable in
     the strict sense: it multiplies |v| by sqrt(1+(f*dt)^2) every single
     step.  The gain is tiny per step but it is a PRODUCT, and it scales with
     sin(lat), so it is largest exactly at the poles -- which is why the
     instability grew from the polar caps.  At Omega = 3.6e-4 and dt = 1800 s
     the polar gain is 1.637 per step.

     Crank-Nicolson evaluates the rotation at the midpoint (v0+v1)/2, which is
     norm-preserving for any f*dt, and the 2x2 system has a closed form.
     Folding the (already implicit) friction denominator D into the same solve
     keeps one consistent update:
         D*v1 = v0 + dt*acc + c*perp(v0+v1),   c = dt*f/2,  D = 1+dt*fric
     =>  v1 = ( D*P - c*Q , D*Q + c*P ) / (D^2 + c^2)
     with P = v0.x + dt*acc.x - c*v0.y,  Q = v0.y + dt*acc.y + c*v0.x.  */
  float fCor = 2.0*uOmega*n.y;
  /* Legacy explicit path, kept verbatim (not algebraically rearranged) so
     uCoriCN = 0 reproduces the pre-fix result BIT FOR BIT. */
  if(uCoriCN < 0.5){
    vec3 c3t = -2.0*cross(vec3(0.0,uOmega,0.0), vt0.x*e1 + vt0.y*e2);
    vec3 c3d = -2.0*cross(vec3(0.0,uOmega,0.0), vd0.x*e1 + vd0.y*e2);
    accT += vec2(dot(c3t,e1), dot(c3t,e2));
    accD += vec2(dot(c3d,e1), dot(c3d,e2));
  }

  /* ---- FRICTION -------------------------------------------------------
     Bottom stress is quadratic, tau_b = rho*Cd*|u|*u, so as a linear rate it
     is Cd*|u|/h: it depends on how much water column the stress is shared
     over. The old code applied one depth-blind rate everywhere, which
     over-damps the abyss by ~50x (6e-7 /s = 19 days, against a physical
     ~900 days for a 4 km column at 0.02 m/s) while under-damping shelves.

     The background rate is additionally tapered by fricDepthRef/D so the
     deep ocean is not spun down by what is really a surface-layer drag.
     Both are folded into the SAME implicit denominator the code already
     used, so the scheme stays unconditionally stable even where the shelf
     drag rate is large (0.4-day e-folding at dt=1800 s). */
  float rBotT = uCdBottom*length(vt0)/max(h1 , hLo);
  float rBotD = uCdBottom*length(vd0)/max(hd1, hLo);
  float depthTaper = uFricDepthRef/max(Dep, uFricDepthRef);
  /* The top layer only feels the sea floor where the column is so shallow
     that it is effectively unstratified (shelf seas); in a deep column the
     deep layer shields it. */
  float topTouchesBed = 1.0 - smoothstep(1.0, 3.0, Dep/max(h1, hLo));
  float fricT = uFricTop *depthTaper + rBotT*topTouchesBed;
  float fricD = uFricDeep*depthTaper + rBotD;
  float cCor = (uCoriCN >= 0.5) ? 0.5*uDt*fCor : 0.0;
  vec2 vt1 = coriFric(vt0, accT, uDt, fricT, cCor);
  vec2 vd1 = coriFric(vd0, accD, uDt, fricD, cCor);
  vt1 *= (1.0-land); vd1 *= (1.0-land);
  vt1 = clamp(vt1, vec2(-3.0), vec2(3.0));
  vd1 = clamp(vd1, vec2(-3.0), vec2(3.0));
  if(any(isnan(vt1))) vt1 = vec2(0.0);
  if(any(isnan(vd1))) vd1 = vec2(0.0);

  // ---- TRACERS (advective form; the divergence correction uses the same
  // face fluxes as the continuity equation, so sum(rho*cp*h*T*A) is preserved
  // by horizontal transport up to the upwind diffusion error) --------------
  vec2 trT1 = trT0 + uDt*(uNuT*lapTt - advTt + trT0*divT);
  vec2 trD1 = trD0 + uDt*(uNuT*lapTd - advTd + trD0*divD);
  trT1.x = clamp(trT1.x, 200.0, 360.0); trT1.y = clamp(trT1.y, 5.0, 60.0);
  trD1.x = clamp(trD1.x, 200.0, 360.0); trD1.y = clamp(trD1.y, 5.0, 60.0);
  if(any(isnan(trT1))) trT1 = trT0;
  if(any(isnan(trD1))) trD1 = trD0;

  // ---- ENTRAINMENT / DETRAINMENT ------------------------------------------
  // Moving the interface moves WATER between the layers, and that water must
  // carry its own T and S with it, otherwise heat/salt are silently created:
  // thickening the top layer by d without this term changes the total content
  // by cp*rho*d*(T_top - T_deep). Mixing the entrained volume in (or detraining
  // top water down) keeps cp*rho*(h_top*T_top + h_deep*T_deep) invariant under
  // the interface motion, exactly as the vertical-exchange term does.
  float dEnt = h1 - h0;
  if(dEnt > 0.0){          // interface deepens: deep water joins the top layer
    float f = clamp(dEnt/max(h1, hLo), 0.0, 1.0);
    trT1 += f*(trD1 - trT1);
  } else if(dEnt < 0.0){   // interface shoals: top water is detrained downward
    float f = clamp(-dEnt/max(hd1, hLo), 0.0, 1.0);
    trD1 += f*(trT1 - trD1);
  }

  oTopS  = vec4(h1, trT1.x, trT1.y, 0.0);
  /* .zw = this step's grad(eta), the lagged input to next step's Rhie-Chow
     face interpolation. Held at 0 when the correction is off so that
     uRhieChow = 0 reproduces the legacy state bit for bit, channels included
     (the verification harness hashes raw texture bytes). */
  oTopV  = vec4(vt1, (uRhieChow > 0.0) ? gradH : vec2(0.0));
  oDeepS = vec4(trD1.x, trD1.y, 0.0, 0.0);
  oDeepV = vec4(vd1, 0.0, 0.0);
}`;

/* ===========================================================================
   SCHEME B — implicit free surface, solved by Jacobi iteration (engine.step
   orchestrates the multi-pass path). Physics in PLAN.md Phase 10.

   The (eta, u) pair is first advanced WITHOUT the pressure gradient (predictor),
   then the coupled Helmholtz system
        eta - dt^2 * PGF * h * lap(eta) = R,
        R = eta_pred - dt*div(h*u*)
   is solved for eta by damped Jacobi. The velocity is then corrected with the
   implicit eta in the correct pass and tracers advect on the corrected field.
   This is unconditionally stable: the stiff gravity-wave mode is solved rather
   than stepped explicitly. Cost = (1 predictor + 1 rhs + implicitIters jacobi
   + 1 correct) passes per step.
   =========================================================================== */

/* Predictor: identical to OCEAN_FS minus the pressure-gradient term (both
   layers), minus div(h*u) in the continuity, minus tracer transport and minus
   entrainment. Writes the predicted state (u*, eta_pred thickness, deep u*) to
   a scratch buffer the correct pass reads. */
var OCEAN_PREDICT_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oTopS;
layout(location=1) out vec4 oTopV;
layout(location=2) out vec4 oDeepS;
layout(location=3) out vec4 oDeepV;

uniform sampler2D uTopS, uTopV, uDeepS, uDeepV;
uniform float uDt, uOmega, uNuVel, uNuT, uFricTop, uFricDeep, uAlphaT, uBetaS;
uniform float uCdBottom, uFricDepthRef;
uniform float uDrag;
uniform float uSteric, uStericRate;
uniform float uMassSpring;
uniform float uHtot, uHref;
uniform float uPgfTop, uPgfDeepGain;
uniform float uRhieChow;
uniform float uCoriCN;

float buoy(float T, float S){ return uAlphaT*(T-283.0) - uBetaS*(S-35.0); }
float gPrime(float Tt, float St, float Td, float Sd){
  float rhoT = 1027.0*(1.0 - uAlphaT*(Tt-283.0) + uBetaS*(St-35.0));
  float rhoD = 1027.0*(1.0 - uAlphaT*(Td-283.0) + uBetaS*(Sd-35.0));
  return 9.81*clamp((rhoD - rhoT)/rhoD, -1.0, 1.0);
}
${CORI_FRIC_GLSL}

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  if(cell >= uCount){
    oTopS = vec4(0.0); oTopV = vec4(0.0); oDeepS = vec4(0.0); oDeepV = vec4(0.0);
    return;
  }
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz), e1 = cb.xyz, e2 = cross(e1, n);
  float area = ca.w, land = cb.w;

  vec4  ts0 = texelFetch(uTopS , cTex(cell), 0);
  vec4  tv0 = texelFetch(uTopV , cTex(cell), 0);
  vec2  vt0 = tv0.xy;
  vec4  ds0 = texelFetch(uDeepS, cTex(cell), 0);
  vec2  vd0 = texelFetch(uDeepV, cTex(cell), 0).xy;
  float h0  = ts0.x;
  float Dep  = cellD(cell);
  float hRef0= cellHref(cell);
  float hd0  = Dep - h0;
  vec2  trT0 = ts0.yz;
  vec2  trD0 = ds0.xy;

  float gp = gPrime(ts0.y, ts0.z, ds0.x, ds0.y);

  float divF = 0.0;
  float divT = 0.0, divD = 0.0;
  vec2  gradH = vec2(0.0);
  float lapEta = 0.0;
  float mDif   = 0.0;
  vec2  lapVt = vec2(0.0), lapVd = vec2(0.0);
  vec2  advVt = vec2(0.0), advVd = vec2(0.0);
  vec2  lapTt = vec2(0.0), lapTd = vec2(0.0);
  vec2  advTt = vec2(0.0), advTd = vec2(0.0);

  for(int k=0;k<6;k++){
    vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
    if(na.w < 0.5) continue;
    int   j = int(na.x);
    float L = na.y;
    float d = na.z;
    vec4  nb = texelFetch(uNbrB, nTex(cell,k), 0);
    vec2  nrm = nb.xy;
    vec4  tsj = texelFetch(uTopS , cTex(j), 0);
    vec4  dsj = texelFetch(uDeepS, cTex(j), 0);
    vec2  vtj = texelFetch(uTopV , cTex(j), 0).xy;
    vec2  vdj = texelFetch(uDeepV, cTex(j), 0).xy;
    float landj = texelFetch(uCellB, cTex(j), 0).w;
    float wet = (1.0-landj)*(1.0-land);

    vtj = xfer(vtj, nb.z, nb.w) * (1.0-landj);
    vdj = xfer(vdj, nb.z, nb.w) * (1.0-landj);

    float unT = 0.5*dot(vt0+vtj, nrm)*wet;
    float unD = 0.5*dot(vd0+vdj, nrm)*wet;
    float dEtaF  = (tsj.x - h0) - (cellHref(j) - hRef0);
    // Rhie-Chow is off in the predictor (uRhieChow is supplied as 0).
    unT -= uRhieChow*uDt*uPgfTop*(dEtaF/d - 0.0)*wet;

    float hFace = 0.5*(h0 + tsj.x);
    divF += L*hFace*unT;
    divT += L*unT;
    divD += L*unD;
    gradH += L*0.5*dEtaF*nrm*wet;
    lapEta += (L/d)*dEtaF*wet;
    mDif   += (L/d)*wet;
    lapVt += (L/d)*(vtj-vt0)*wet;
    lapVd += (L/d)*(vdj-vd0)*wet;
    vec2 trTj = tsj.yz, trDj = dsj.xy;
    lapTt += (L/d)*(trTj-trT0);
    lapTd += (L/d)*(trDj-trD0);
    float wT = unT > 0.0 ? 0.0 : 1.0;
    float wD = unD > 0.0 ? 0.0 : 1.0;
    advTt += L*unT*mix(trT0, trTj, wT);
    advTd += L*unD*mix(trD0, trDj, wD);
    advVt += L*unT*mix(vt0,  vtj,  wT);
    advVd += L*unD*mix(vd0,  vdj,  wD);
  }

  float ia = 1.0/area;
  divF *= ia; divT *= ia; divD *= ia; gradH *= ia; lapEta *= ia; mDif *= ia;
  lapVt *= ia; lapVd *= ia; advVt *= ia; advVd *= ia;
  lapTt *= ia; lapTd *= ia; advTt *= ia; advTd *= ia;

  // ---- CONTINUITY (no div(h*u) term: it is recovered implicitly) ----------
  float hEq = hRef0 + uSteric*buoy(ts0.y, ts0.z);
  float h1 = h0
                 - uDt*uStericRate*(h0 - hEq)
                 - uDt*uMassSpring*(h0 - hRef0);
  h1 = clampH(h1, Dep);
  if(isnan(h1)) h1 = h0;
  float hd1 = Dep - h1;

  // ---- MOMENTUM (pressure gradient omitted for both layers) ---------------
  vec2 accT = uNuVel*lapVt - advVt + vt0*divT;
  vec2 accD = uNuVel*lapVd - advVd + vd0*divD;

  vec2  dv  = vt0 - vd0;
  float hLo, hHi; hLimits(Dep, hLo, hHi);
  float dragStrat = 0.1 + 0.9*min(1.0, stratMix(bulkRi(gp, h1, dv)));
  vec2  tau = uDrag*dragStrat*length(dv)*dv;
  accT -= tau/(1027.0*max(h1 , hLo));
  accD += tau/(1027.0*max(hd1, hLo));

  float fCor = 2.0*uOmega*n.y;
  if(uCoriCN < 0.5){
    vec3 c3t = -2.0*cross(vec3(0.0,uOmega,0.0), vt0.x*e1 + vt0.y*e2);
    vec3 c3d = -2.0*cross(vec3(0.0,uOmega,0.0), vd0.x*e1 + vd0.y*e2);
    accT += vec2(dot(c3t,e1), dot(c3t,e2));
    accD += vec2(dot(c3d,e1), dot(c3d,e2));
  }
  float rBotT = uCdBottom*length(vt0)/max(h1 , hLo);
  float rBotD = uCdBottom*length(vd0)/max(hd1, hLo);
  float depthTaper = uFricDepthRef/max(Dep, uFricDepthRef);
  float topTouchesBed = 1.0 - smoothstep(1.0, 3.0, Dep/max(h1, hLo));
  float fricT = uFricTop *depthTaper + rBotT*topTouchesBed;
  float fricD = uFricDeep*depthTaper + rBotD;
  float cCor = (uCoriCN >= 0.5) ? 0.5*uDt*fCor : 0.0;
  vec2 vt1 = coriFric(vt0, accT, uDt, fricT, cCor);
  vec2 vd1 = coriFric(vd0, accD, uDt, fricD, cCor);
  vt1 *= (1.0-land); vd1 *= (1.0-land);
  vt1 = clamp(vt1, vec2(-3.0), vec2(3.0));
  vd1 = clamp(vd1, vec2(-3.0), vec2(3.0));
  if(any(isnan(vt1))) vt1 = vec2(0.0);
  if(any(isnan(vd1))) vd1 = vec2(0.0);

  // Tracers and entrainment are deferred to the correct pass (once eta is known).
  vec2 trT1 = trT0;
  vec2 trD1 = trD0;
  if(any(isnan(trT1))) trT1 = trT0;
  if(any(isnan(trD1))) trD1 = trD0;

  oTopS  = vec4(h1, trT1.x, trT1.y, 0.0);
  oTopV  = vec4(vt1, vec2(0.0));
  oDeepS = vec4(trD1.x, trD1.y, 0.0, 0.0);
  oDeepV = vec4(vd1, 0.0, 0.0);
}`;

/* RHS probe: evaluate R = eta_pred - dt*div(h*u*) from the predicted state,
   reusing the same 1-ring FV face-flux stencil as OCEAN_FS. eta_pred is the
   predictor thickness minus the cell reference. Output (x=eta_pred, y=R). */
var OCEAN_RHS_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oEta;
uniform sampler2D uTopS, uTopV, uDeepS, uDeepV;
uniform float uDt, uPgfTop;
void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  if(cell >= uCount){ oEta = vec4(0.0); return; }
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  float land = cb.w;
  vec4  ts0 = texelFetch(uTopS, cTex(cell), 0);
  vec4  tv0 = texelFetch(uTopV, cTex(cell), 0);
  vec2  vt0 = tv0.xy;
  float h0  = ts0.x;
  float hRef0= cellHref(cell);
  float etaPred = h0 - hRef0;

  float divF = 0.0;
  for(int k=0;k<6;k++){
    vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
    if(na.w < 0.5) continue;
    int   j = int(na.x);
    float L = na.y;
    float d = na.z;
    vec4  nb = texelFetch(uNbrB, nTex(cell,k), 0);
    vec2  nrm = nb.xy;
    vec4  tsj = texelFetch(uTopS , cTex(j), 0);
    vec2  vtj = texelFetch(uTopV , cTex(j), 0).xy;
    float landj = texelFetch(uCellB, cTex(j), 0).w;
    float wet = (1.0-landj)*(1.0-land);
    vtj = xfer(vtj, nb.z, nb.w) * (1.0-landj);
    float unT = 0.5*dot(vt0+vtj, nrm)*wet;
    float hFace = 0.5*(h0 + tsj.x);
    divF += L*hFace*unT;
  }
  float area = texelFetch(uCellA, cTex(cell), 0).w;
  divF /= area;

  float R = etaPred - uDt*divF;
  if(isnan(R)) R = etaPred;
  oEta = vec4(etaPred, R, 0.0, 0.0);
}`;

/* Jacobi iteration for the implicit eta. Each pass reads the current iterate
   (x=eta^k, y=R, the fixed RHS) and writes the next iterate, carrying R forward
   and recording |residual| in .w so the engine can track convergence and
   early-exit. The Laplacian uses the identical FV stencil as OCEAN_FS. */
var OCEAN_JACOBI_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oEta;
uniform sampler2D uEtaIn;
uniform float uDt, uPgfTop, uJacobiOmega;
void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  if(cell >= uCount){ oEta = vec4(0.0); return; }
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  float land = cb.w;
  float hRef0 = cellHref(cell);
  float etaK = texelFetch(uEtaIn, cTex(cell), 0).x;
  float R    = texelFetch(uEtaIn, cTex(cell), 0).y;

  float lapEta = 0.0;
  for(int k=0;k<6;k++){
    vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
    if(na.w < 0.5) continue;
    int   j = int(na.x);
    float L = na.y;
    float d = na.z;
    vec4  nb = texelFetch(uNbrB, nTex(cell,k), 0);
    vec2  nrm = nb.xy;
    float etaJ = texelFetch(uEtaIn, cTex(j), 0).x;
    float landj = texelFetch(uCellB, cTex(j), 0).w;
    float wet = (1.0-landj)*(1.0-land);
    float dEtaF = (etaJ - etaK);
    lapEta += (L/d)*dEtaF*wet;
  }
  float area = texelFetch(uCellA, cTex(cell), 0).w;
  lapEta /= area;

  // h_k is the local top-layer thickness the divergence operator multiplies by.
  float hK = etaK + hRef0;
  float res = R - (etaK - uDt*uDt*uPgfTop*hK*lapEta);
  float etaNew = etaK + uJacobiOmega*res;
  if(isnan(etaNew)) etaNew = etaK;
  oEta = vec4(etaNew, R, 0.0, abs(res));
}`;

/* Correct: apply the implicit eta to the velocity (both layers), advect tracers
   on the corrected face velocities, and apply entrainment using the implicit
   interface displacement. Writes the final ocean state (same layout as OCEAN_FS)
   so the coupling pass, tracer advection, render modes 15/16/17 and particle
   streaks are all untouched. If eta_final is NaN it falls back to eta_pred
   (predictor), degrading gracefully to Scheme-A-like behaviour. */
var OCEAN_CORRECT_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oTopS;
layout(location=1) out vec4 oTopV;
layout(location=2) out vec4 oDeepS;
layout(location=3) out vec4 oDeepV;

uniform sampler2D uTopS, uTopV, uDeepS, uDeepV;
uniform sampler2D uEta;
uniform float uDt, uNuT, uAlphaT, uBetaS;
uniform float uPgfTop, uPgfDeepGain;

float buoy(float T, float S){ return uAlphaT*(T-283.0) - uBetaS*(S-35.0); }
float gPrime(float Tt, float St, float Td, float Sd){
  float rhoT = 1027.0*(1.0 - uAlphaT*(Tt-283.0) + uBetaS*(St-35.0));
  float rhoD = 1027.0*(1.0 - uAlphaT*(Td-283.0) + uBetaS*(Sd-35.0));
  return 9.81*clamp((rhoD - rhoT)/rhoD, -1.0, 1.0);
}

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  if(cell >= uCount){
    oTopS = vec4(0.0); oTopV = vec4(0.0); oDeepS = vec4(0.0); oDeepV = vec4(0.0);
    return;
  }
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  float area = ca.w, land = cb.w;

  vec4  ts0 = texelFetch(uTopS , cTex(cell), 0);
  vec4  tv0 = texelFetch(uTopV , cTex(cell), 0);
  vec2  vt0 = tv0.xy;
  vec4  ds0 = texelFetch(uDeepS, cTex(cell), 0);
  vec2  vd0 = texelFetch(uDeepV, cTex(cell), 0).xy;
  float h0  = ts0.x;
  float Dep  = cellD(cell);
  float hRef0= cellHref(cell);
  float etaPred = h0 - hRef0;
  vec2  trT0 = ts0.yz;
  vec2  trD0 = ds0.xy;

  vec4 etaTex = texelFetch(uEta, cTex(cell), 0);
  float etaFinal = etaTex.x;
  if(isnan(etaFinal)) etaFinal = etaPred;          // graceful NaN fallback

  float gp = gPrime(ts0.y, ts0.z, ds0.x, ds0.y);

  float divT = 0.0, divD = 0.0;
  vec2  gradH  = vec2(0.0);
  vec2  lapTt = vec2(0.0), lapTd = vec2(0.0);
  vec2  advTt = vec2(0.0), advTd = vec2(0.0);

  for(int k=0;k<6;k++){
    vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
    if(na.w < 0.5) continue;
    int   j = int(na.x);
    float L = na.y;
    float d = na.z;
    vec4  nb = texelFetch(uNbrB, nTex(cell,k), 0);
    vec2  nrm = nb.xy;
    vec4  tsj = texelFetch(uTopS , cTex(j), 0);
    vec4  dsj = texelFetch(uDeepS, cTex(j), 0);
    vec2  vtj = texelFetch(uTopV , cTex(j), 0).xy;
    vec2  vdj = texelFetch(uDeepV, cTex(j), 0).xy;
    float landj = texelFetch(uCellB, cTex(j), 0).w;
    float wet = (1.0-landj)*(1.0-land);

    vtj = xfer(vtj, nb.z, nb.w) * (1.0-landj);
    vdj = xfer(vdj, nb.z, nb.w) * (1.0-landj);

    float etaJ = texelFetch(uEta, cTex(j), 0).x;
    float dEtaF = (etaJ - etaFinal);

    float unT = 0.5*dot(vt0+vtj, nrm)*wet;
    float unD = 0.5*dot(vd0+vdj, nrm)*wet;
    // semi-implicit free-surface pressure correction to the face flux:
    unT -= uDt*uPgfTop*(dEtaF/d)*wet;
    unD += uDt*uPgfDeepGain*gp*(dEtaF/d)*wet;

    divT += L*unT;
    divD += L*unD;
    gradH += L*0.5*dEtaF*nrm*wet;
    vec2 trTj = tsj.yz, trDj = dsj.xy;
    lapTt += (L/d)*(trTj-trT0);
    lapTd += (L/d)*(trDj-trD0);
    float wT = unT > 0.0 ? 0.0 : 1.0;
    float wD = unD > 0.0 ? 0.0 : 1.0;
    advTt += L*unT*mix(trT0, trTj, wT);
    advTd += L*unD*mix(trD0, trDj, wD);
  }

  float ia = 1.0/area;
  divT *= ia; divD *= ia; gradH *= ia; lapTt *= ia; lapTd *= ia; advTt *= ia; advTd *= ia;

  // central velocity correction (the implicit pressure gradient)
  vec2 vt1 = vt0 - uDt*uPgfTop*gradH;
  vec2 vd1 = vd0 + uDt*uPgfDeepGain*gp*gradH;
  vt1 *= (1.0-land); vd1 *= (1.0-land);
  vt1 = clamp(vt1, vec2(-3.0), vec2(3.0));
  vd1 = clamp(vd1, vec2(-3.0), vec2(3.0));
  if(any(isnan(vt1))) vt1 = vec2(0.0);
  if(any(isnan(vd1))) vd1 = vec2(0.0);

  // tracers advected with the corrected field
  vec2 trT1 = trT0 + uDt*(uNuT*lapTt - advTt + trT0*divT);
  vec2 trD1 = trD0 + uDt*(uNuT*lapTd - advTd + trD0*divD);
  trT1.x = clamp(trT1.x, 200.0, 360.0); trT1.y = clamp(trT1.y, 5.0, 60.0);
  trD1.x = clamp(trD1.x, 200.0, 360.0); trD1.y = clamp(trD1.y, 5.0, 60.0);
  if(any(isnan(trT1))) trT1 = trT0;
  if(any(isnan(trD1))) trD1 = trD0;

  // entrainment across the interface from the IMPLICIT displacement
  float dEnt = etaFinal - etaPred;
  float hLo, hHi; hLimits(Dep, hLo, hHi);
  float h1Final = etaFinal + hRef0;
  if(dEnt > 0.0){
    float f = clamp(dEnt/max(h1Final, hLo), 0.0, 1.0);
    trT1 += f*(trD1 - trT1);
  } else if(dEnt < 0.0){
    float f = clamp(-dEnt/max(Dep - h1Final, hLo), 0.0, 1.0);
    trD1 += f*(trT1 - trD1);
  }

  oTopS  = vec4(h1Final, trT1.x, trT1.y, 0.0);
  oTopV  = vec4(vt1, vec2(0.0));
  oDeepS = vec4(trD1.x, trD1.y, 0.0, 0.0);
  oDeepV = vec4(vd1, 0.0, 0.0);
}`;

/* 1-fragment max-reduction over the .w channel (|residual|). Used by the engine
   to track Jacobi convergence per iteration and early-exit. Reads the whole grid
   in one fragment; cheap enough given scheme B is the slow path by design. */
var MAX_FS = SHADER_HEAD + SHADER_COMMON + `
out vec4 o;
uniform sampler2D uSrc;
void main(){
  int W = uDim.x;
  float m = 0.0;
  for(int i=0;i<200000;i++){
    if(i >= uCount) break;
    int x = i - (i/W)*W;
    int y = i / W;
    float v = texelFetch(uSrc, ivec2(x,y), 0).w;
    if(v > m) m = v;
  }
  o = vec4(m, 0.0, 0.0, 1.0);
}`;

var AIR_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oLoA;
layout(location=1) out vec4 oLoB;
layout(location=2) out vec4 oHiA;
layout(location=3) out vec4 oHiB;

uniform sampler2D uLoA, uLoB, uHiA, uHiB;
uniform float uDt, uOmega, uNuVel, uNuT, uFricLo, uFricHi, uRhoLo, uRhoHi, uCoriCN, uCourantMax, uAirAdvect;
uniform float uAirCs;        // baroclinic gravity-wave speed; 0 = keep P diagnostic
uniform float uAirFbStab;    // forward-backward damper for the (P, u) wave

${CORI_FRIC_GLSL}

void stepAir(int cell, vec3 n, vec3 e1, vec3 e2, float area, float land,
             sampler2D tA, sampler2D tB, float fric, float rho,
             out vec4 outA, out vec4 outB)
{
  vec4 a0 = texelFetch(tA, cTex(cell), 0);
  vec4 b0 = texelFetch(tB, cTex(cell), 0);
  vec2 v0 = a0.xy;
  vec3 tr0 = vec3(a0.z, b0.x, b0.y);
  float p0 = a0.w;

  vec2 gradP = vec2(0.0), lapV = vec2(0.0), advV = vec2(0.0);
  vec3 lapT  = vec3(0.0), advT = vec3(0.0);
  float div = 0.0, lapP = 0.0, mDif = 0.0;

  for(int k=0;k<6;k++){
    vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
    if(na.w < 0.5) continue;
    int j = int(na.x);
    float L = na.y, d = na.z;
    vec4 nb = texelFetch(uNbrB, nTex(cell,k), 0);
    vec2 nrm = nb.xy;

    vec4 aj = texelFetch(tA, cTex(j), 0);
    vec4 bj = texelFetch(tB, cTex(j), 0);
    vec2 vj = xfer(aj.xy, nb.z, nb.w);
    vec3 trj = vec3(aj.z, bj.x, bj.y);

    gradP += L*0.5*(aj.w-p0)*nrm;
    lapV  += (L/d)*(vj-v0);
    lapT  += (L/d)*(trj-tr0);
    /* Explicit upwind face flux. Cap the per-face Courant number so large-dt
       runs cannot over-diffuse the way the raw upwind scheme does (the source
       of the dt-dependent wind bias). The cap rescales the normal velocity
       un -> unEff, used for BOTH momentum and tracer advection and for the
       divergence term, so the whole transport stays consistent. d is the
       precomputed center-to-center distance from uNbrA; guard it for
       degenerate cells. */
    float un = 0.5*dot(v0+vj, nrm);
    float unEff = un;
    float cour = abs(un) * uDt / max(d, 1.0e-3);
    if (cour > uCourantMax) unEff = un * (uCourantMax / cour);
    div += L*unEff;
    float w = unEff > 0.0 ? 0.0 : 1.0;
    advT += L*unEff*mix(tr0, trj, w);
    advV += L*unEff*mix(v0,  vj,  w);
    lapP  += (L/d)*(aj.w-p0);
    mDif  += (L/d);
  }

  float ia = 1.0/area;
  gradP *= ia; lapV *= ia; lapT *= ia; advV *= ia; advT *= ia; div *= ia;
  lapP *= ia; mDif *= ia;

  /* Optional Semi-Lagrangian air advection (uAirAdvect == 1). Back-trajectory
     of the cell center along -v0*dt, sample the departure value from the
     6-ring neighbours (+ the cell itself) by inverse-distance weighting, and
     fold it into the SAME acc terms the FV path uses (advV/advT with div=0),
     so pressure-gradient / Coriolis / friction are untouched. This is a
     comparison scaffold, not the default; FV (capped) remains the default. */
  if (uAirAdvect > 0.5) {
    vec2 disp = -v0 * uDt;            // back-trajectory displacement (m)
    vec2 vDep = vec2(0.0);
    vec3 trDep = vec3(0.0);
    float wsum = 0.0;
    for(int k=0;k<6;k++){
      vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
      if(na.w < 0.5) continue;
      int j = int(na.x);
      float d2 = na.z;
      vec4 nb = texelFetch(uNbrB, nTex(cell,k), 0);
      vec2 nrm2 = nb.xy;
      vec4 aj = texelFetch(tA, cTex(j), 0);
      vec4 bj = texelFetch(tB, cTex(j), 0);
      vec2 vj = xfer(aj.xy, nb.z, nb.w);
      vec3 trj = vec3(aj.z, bj.x, bj.y);
      vec2 pk = d2 * nrm2;            // neighbour centre position (m)
      float wgt = 1.0 / (dot(pk - disp, pk - disp) + 1.0e6);
      vDep += wgt * vj;
      trDep += wgt * trj;
      wsum += wgt;
    }
    /* include the cell centre itself so a near-zero displacement is stable */
    float wgt0 = 1.0 / (dot(disp, disp) + 1.0e6);
    vDep += wgt0 * v0;
    trDep += wgt0 * tr0;
    wsum += wgt0;
    vDep /= wsum;
    trDep /= wsum;
    float idt = 1.0 / max(uDt, 1.0e-6);
    advV = (v0 - vDep) * idt;
    advT = (tr0 - trDep) * idt;
    div = 0.0;
  }

  vec2 acc = -gradP/rho + uNuVel*lapV - advV + v0*div;

  float f = fric*(1.0 + 2.0*land);
  /* Traditional Coriolis f = 2Ω sinφ (n.y = sin latitude). The air used to
     run CN on an f-plane f=2Ω, which kills the β effect: no Rossby-wave
     drift, and the same rotation rate at the equator as at the pole. The
     explicit path already used the 3-D cross product (≡ 2Ω n.y in-plane);
     CN must match. */
  float fCor = 2.0*uOmega*n.y;
  /* The air used to add the Coriolis force EXPLICITLY (forward Euler on a pure
     rotation), which makes |v| grow by sqrt(1+(f*dt)^2) every step and, because
     the friction is only an implicit denominator, leaves the balanced (geo-
     strophic) wind dt-DEPENDENT: surface air blows ~3x harder at dt=10 s than at
     dt=300 s. The ocean already uses the norm-preserving Crank-Nicolson form
     below; the air must do the same so wind speed no longer depends on dt. */
  vec2 v1;
  if(uCoriCN < 0.5){
    vec3 v3 = v0.x*e1 + v0.y*e2;
    vec3 c3 = -2.0*cross(vec3(0.0,uOmega,0.0), v3);
    acc += vec2(dot(c3,e1), dot(c3,e2));
    v1 = (v0 + uDt*acc)/(1.0 + uDt*f);
  } else {
    float cCor = 0.5*uDt*fCor;
    v1 = coriFric(v0, acc, uDt, f, cCor);
  }
  v1 = clamp(v1, vec2(-60.0), vec2(60.0));

  vec3 tr1 = tr0 + uDt*(uNuT*lapT - advT + tr0*div);
  tr1.x = clamp(tr1.x, 150.0, 360.0);
  tr1.y = clamp(tr1.y, 0.0, 0.08);
  tr1.z = clamp(tr1.z, 0.0, 4.0);
  if(any(isnan(v1))) v1 = vec2(0.0);
  if(any(isnan(tr1))) tr1 = tr0;

  /* Prognostic air pressure. Linearised baroclinic shallow water:
       ∂P/∂t = -c² ρ ∇·u
     plus the same forward-backward Laplacian damper the ocean uses on eta.
     uAirCs = 0 keeps P as a diagnostic the couple pass overwrites from T
     (legacy: vortices sit still, slaved to the standing thermal field). */
  float p1 = p0;
  if(uAirCs > 0.5){
    float cs2 = uAirCs*uAirCs;
    float nu2 = uAirFbStab*uDt*uDt*cs2*mDif;
    float fbGain = nu2/(1.0 + nu2);
    /* Linearised continuity only. Advecting p' (flux form) drained column
       mass and drove high-air P into the 15 kPa floor inside a day. Vorticity
       still travels with the wind; P adjusts geostrophically. */
    p1 = p0 - uDt*cs2*rho*div + fbGain*uDt*uDt*cs2*lapP;
    p1 = clamp(p1, p0 - 8000.0, p0 + 8000.0);
    p1 = clamp(p1, 15000.0, 130000.0);
    if(isnan(p1)) p1 = p0;
  }

  outA = vec4(v1, tr1.x, p1);
  outB = vec4(tr1.y, tr1.z, b0.z, b0.w);
}

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  if(cell >= uCount){ oLoA=vec4(0.0); oLoB=vec4(0.0); oHiA=vec4(0.0); oHiB=vec4(0.0); return; }
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz), e1 = cb.xyz, e2 = cross(e1, n);
  stepAir(cell, n, e1, e2, ca.w, cb.w, uLoA, uLoB, uFricLo, uRhoLo, oLoA, oLoB);
  stepAir(cell, n, e1, e2, ca.w, cb.w, uHiA, uHiB, uFricHi, uRhoHi, oHiA, oHiB);
}`;

/* Coupling pass. Compiled twice (ocean / air): both variants read all 8 state
   textures but each writes only its own <= 4 attachments.

   Conservation invariants (per cell):
     MASS      h_top + h_deep = D exactly (h_deep is derived);
               E-P and uSurfMass move the interface, never the total volume.
     MOMENTUM  wind stress is exchanged with inverse-column-mass weighting, so
               the air loses exactly the impulse the ocean gains.
     HEAT      Q = k*(T_deep - T_top) [W/m^2] applied as
                 dT_top = +Q dt/(cp*rho*h_top), dT_deep = -Q dt/(cp*rho*h_deep)
               => cp*rho*(h_top*dT_top + h_deep*dT_deep) = 0 exactly.
     SALT      analogous symmetric exchange. */
function COUPLE_FS(mode) {
  var outs = mode === 'ocean'
    ? `layout(location=0) out vec4 oTopS;\nlayout(location=1) out vec4 oTopV;\nlayout(location=2) out vec4 oDeepS;\nlayout(location=3) out vec4 oDeepV;`
    : `layout(location=0) out vec4 oLoA;\nlayout(location=1) out vec4 oLoB;\nlayout(location=2) out vec4 oHiA;\nlayout(location=3) out vec4 oHiB;`;
  return SHADER_HEAD + SHADER_COMMON + `
${outs}

uniform sampler2D uTopS, uTopV, uDeepS, uDeepV, uLoA, uLoB, uHiA, uHiB;
uniform float uDt, uTime;
uniform vec3  uSun;
uniform float uSolar, uDayNight, uSeasonDecl;
uniform float uKsurf, uEvap, uWindStress, uConv, uKrad, uLapse;
uniform float uThermo, uCloudK, uRainK, uNoise, uGreenhouse;
uniform float uSurfMass;   // extra uniform surface mass forcing on h_top (m/s)
uniform float uVertHeat;   // vertical heat exchange coeff [W/m^2/K]
uniform float uVertSalt;   // vertical salt exchange coeff [kg/m^2/s per ppt]
uniform float uHtot;       // total ocean depth [m]

uniform float uAirCs;      // 0 = overwrite P from T (legacy); else relax toward it
uniform float uAirPRelax;  // 1/s nudge of prognostic P toward thermal P(T)
uniform float uAirDpdT;    // Pa/K low-air thermal P
uniform float uAirDpdTHi;  // Pa/K high-air thermal P

const float Le   = 2.5e6;
const float cpA  = 1004.0;
const float cpW  = 4000.0;
const float rhoW = 1027.0;
const float CwLd = 5.0e6;
const float Ca   = 5.6e6;
const float Cah  = 3.6e6;
const float rhoL = 1.1;
const float Hlo  = 5000.0;
const float Hhi  = 6000.0;

float meanInsol(float lat, float decl){
  float x = -tan(clamp(lat,-1.4,1.4))*tan(decl);
  float h0 = acos(clamp(x,-1.0,1.0));
  return max(0.0,(h0*sin(lat)*sin(decl) + cos(lat)*cos(decl)*sin(h0))/3.14159265);
}

${CORI_FRIC_GLSL}

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  float land = cb.w;
  float lat = asin(clamp(n.y,-1.0,1.0));

  vec4 ts = texelFetch(uTopS , cTex(cell), 0);   // (h_top, T_top, S_top, _)
  vec4 ds = texelFetch(uDeepS, cTex(cell), 0);   // (T_deep, S_deep, _, _)
  vec4 tv = texelFetch(uTopV , cTex(cell), 0);
  vec2 vt = tv.xy;
  vec2 vd = texelFetch(uDeepV, cTex(cell), 0).xy;
  vec4 la = texelFetch(uLoA , cTex(cell), 0);
  vec4 lb = texelFetch(uLoB , cTex(cell), 0);
  vec4 ha = texelFetch(uHiA , cTex(cell), 0);
  vec4 hb = texelFetch(uHiB , cTex(cell), 0);

  float Dep = cellD(cell);
  float hT = clampH(ts.x, Dep);
  float hD = Dep - hT;
  float Ts = ts.y, St = ts.z;      float Td = ds.x, Sd = ds.y;
  vec2  vl = la.xy,  vh = ha.xy;
  float Tl = la.z,   Th = ha.z;
  float q  = lb.x,   qh = hb.x;
  float cloud = lb.y, rain = hb.y;

  // heat capacity per m^2 of each ocean layer, and of the land skin
  float CwT = cpW*rhoW*hT;         // J/m^2/K
  float CwD = cpW*rhoW*hD;
  float Cw  = mix(CwT, CwLd, land);

  float mu = mix(meanInsol(lat, uSeasonDecl), max(0.0, dot(n, uSun)), uDayNight);
  float alb = mix(0.08, 0.28, land) + 0.35*clamp(cloud,0.0,1.0);
  alb += 0.5*smoothstep(273.0, 258.0, Ts);
  float S = uSolar*mu*(1.0 - clamp(alb,0.0,0.9));

  float spd = length(vl);
  float qs_s = qsat(Ts, 101325.0);
  float evap = (1.0 - 0.75*land)*uEvap*(0.6 + 0.08*spd)*max(0.0, qs_s - q);  // kg/m2/s
  float precip = rain*0.001*(1.0-land);                                      // kg/m2/s
  // Net freshwater loss from the ocean surface. Masked ONCE, here, so that the
  // salinity update and the thickness update below see exactly the same flux
  // (otherwise rho*h*S stops being conserved, and land cells drift in S).
  float EmP = (evap - precip)*(1.0-land);                                    // net loss
  float Fsens = uKsurf*(Ts - Tl);
  float Fsol_s = S*0.76;

  Ts += uDt*(Fsol_s - Fsens - Le*evap)/Cw;
  Tl += uDt*(Fsens + 0.10*S)/Ca;
  q  += uDt*evap/(rhoL*Hlo);
  // Evaporation leaves salt behind, precipitation dilutes: the salt CONTENT
  // rho*h*S of the top layer is unchanged, only its thickness changes, so
  // dS = +E*S/(rho*h).
  St += uDt*EmP*St/(rhoW*hT);

  // ---- SURFACE MASS FLUX: only the interface moves, total volume is fixed --
  float hT0 = hT;
  hT = clampH(hT - uDt*(EmP/rhoW + uSurfMass*(1.0-land)), Dep);
  hD = Dep - hT;
  // The interface moved, so water crossed it and must carry its T and S along
  // (same entrainment/detrainment bookkeeping as in the dynamics pass).
  float dEnt = hT - hT0;
  if(dEnt > 0.0){
    float fEnt = clamp(dEnt/hT, 0.0, 1.0);
    Ts += fEnt*(Td - Ts);  St += fEnt*(Sd - St);
  } else if(dEnt < 0.0){
    float fEnt = clamp(-dEnt/hD, 0.0, 1.0);
    Td += fEnt*(Ts - Td);  Sd += fEnt*(St - Sd);
  }
  // layer heat capacities follow the new thicknesses
  CwT = cpW*rhoW*hT;
  CwD = cpW*rhoW*hD;

  // Wind stress: Newton's 3rd law, mass-weighted. The ocean top layer (~200 m
  // of water) has far more inertia per m^2 than the low-air column (~5000 m of
  // thin air): massRatio = (rhoL*Hlo)/(rhoW*h_top) ~= 1/37, so the SAME
  // momentum flux barely nudges the ocean but strongly decelerates the wind.
  vec2 rel = vl - vt;
  vec2 dstress = uWindStress*uDt*rel*(1.0-land);
  float massRatio = (rhoL*Hlo)/(rhoW*hT);
  vl -= dstress;
  vt += dstress*massRatio;

  float win = mix(0.35, 0.12, uGreenhouse);
  Tl -= uDt*win*(100.0 + 1.6*(Tl-273.0))/Ca;
  Th -= uDt*(215.0 + 2.2*(Th-250.0))/Cah;
  float Erad = uDt*uKrad*(Tl - Th)/Ca;
  Tl -= Erad;  Th += Erad*Ca/Cah;

  float buoy = (Tl - Th - uLapse) + 900.0*q;
  float r = clamp(uConv*max(0.0, buoy)*uDt, 0.0, 0.45);
  float dTc = r*(Tl - Th - uLapse);
  Tl -= dTc;
  Th += dTc*Ca/Cah;
  float dq = r*(q - qh);
  q  -= dq;
  qh += dq*Hlo/Hhi;
  vec2 dmom = 0.35*r*(vl - vh);
  vl -= dmom; vh += dmom*0.6;

  float qsh = qsat(Th, 45000.0);
  float cond = max(0.0, qh - qsh)*0.4;
  qh -= cond;
  Th += cond*Le/cpA*0.35;
  float qsl = qsat(Tl, 98000.0);
  float condl = max(0.0, q - qsl)*0.25;
  q  -= condl;
  Tl += condl*Le/cpA*0.30;

  float newCloud = uCloudK*(clamp(q/max(qsl,1e-5),0.0,1.2) - 0.62) + 220.0*(cond+condl);
  cloud = mix(cloud, clamp(newCloud, 0.0, 1.0), 0.06);
  rain  = mix(rain, clamp((cond+condl)*uRainK, 0.0, 4.0), 0.10);

  // ---- VERTICAL EXCHANGE (top <-> deep), all strictly symmetric -----------
  // The exchanges are written in content form, so nothing is created or
  // destroyed; only the RATE responds to stratification.
  //
  // The old rate was 1 + 900*abs(rt-rd), and the abs() inverted the physics:
  // a strongly STABLE column (light water over dense, rt-rd < 0) got a large
  // multiplier and therefore mixed HARDER, when stable stratification is
  // precisely what suppresses vertical exchange. Only the unstable sign
  // should enhance mixing. Sign convention here: r is a density anomaly, so
  // rt > rd means dense-over-light, i.e. convectively unstable.
  float rt = -0.00017*(Ts-283.0) + 0.00078*(St-35.0);
  float rd = -0.00017*(Td-283.0) + 0.00078*(Sd-35.0);
  float dRho = rt - rd;                        // >0 unstable, <0 stable
  vec2  dvOc = vt - vd;
  float gpOc = max(-dRho, 0.0)*9.81/1.0;       // reduced gravity of the pair
  float stab;
  if(dRho > 0.0){
    // convectively unstable: overturning, capped so dt*rate stays sane
    stab = min(uMixConv, 1.0 + 900.0*dRho);
  } else {
    // stable: shear must work against buoyancy -> Richardson suppression
    stab = stratMix(bulkRi(gpOc, hT, dvOc));
  }

  // heat: Q [W/m^2]; heat lost by one layer == heat gained by the other
  float Q = uVertHeat*stab*(Td - Ts);
  Ts += Q*uDt/CwT;
  Td -= Q*uDt/CwD;

  // salt: K [kg/m^2/s]; rho*h_top*dS_top = +K dt, rho*h_deep*dS_deep = -K dt
  float K = uVertSalt*stab*(Sd - St);
  St += K*uDt/(rhoW*hT);
  Sd -= K*uDt/(rhoW*hD);

  // additional thermohaline (buoyancy-driven) exchange, same content form
  float mix_ = clamp(uThermo*stab*uDt, 0.0, 0.15);
  float dT = mix_*(Td - Ts), dS = mix_*(Sd - St);
  Ts += dT*(CwD/(CwT+CwD));  Td -= dT*(CwT/(CwT+CwD));
  St += dS*(hD /(hT+hD));    Sd -= dS*(hT /(hT+hD));

  // MECHANICAL inter-layer friction is handled in the dynamics pass (uDrag),
  // independent of stratification; nothing buoyancy-driven acts on u here, so
  // ocean momentum is untouched by this pass except through the wind stress.

  float nz = hash21(vec2(float(cell), floor(uTime*0.37)))-0.5;
  /* Symmetry-break noise. The original code added a FIXED amplitude every
     step (Tl += uNoise*nz), so over a fixed simulated time the accumulated
     forcing scaled as N = T/dt — i.e. ~1/dt. That made the air dt-DEPENDENT:
     smaller dt injected far more noise, spun the wind up harder, and (through
     Tl->pressure) produced a larger pressure gradient. Scale the per-step
     increment by dt so the total forcing over any fixed time is independent of
     dt. Reference dt = 60 (the default) preserves the original tuned amplitude
     at the default timestep. */
  Tl += uNoise * nz * (uDt / 60.0);

  /* Thermal diagnostic P(T). Used as the sole air pressure when uAirCs==0
     (legacy: wind is slaved to a standing T field, so cells never travel).
     Otherwise this is only a relaxation TARGET: the air step integrates
     ∂P/∂t = -c²ρ∇·u, and we nudge toward P_therm on a ~day timescale so
     Hadley/Walker stay thermally driven without instantly wiping eddies. */
  float PlTh = 101325.0 - uAirDpdT*(Tl - 288.0) + 0.4*uAirDpdT*(Th - 250.0);
  float PhTh = 45000.0  + uAirDpdTHi*(0.5*(Tl + Th) - 268.0);
  float Pl, Ph;
  if(uAirCs < 0.5){
    Pl = PlTh;
    Ph = PhTh;
  } else {
    float a = 1.0 - exp(-uAirPRelax*uDt);
    Pl = mix(la.w, PlTh, a);
    Ph = mix(ha.w, PhTh, a);
  }

  Ts = clamp(Ts, 200.0, 360.0);  Td = clamp(Td, 200.0, 360.0);
  Tl = clamp(Tl, 150.0, 360.0);  Th = clamp(Th, 150.0, 360.0);
  St = clamp(St, 5.0, 60.0);     Sd = clamp(Sd, 5.0, 60.0);
  q  = clamp(q , 0.0, 0.08);     qh = clamp(qh, 0.0, 0.08);
  vt *= (1.0-land);              vd *= (1.0-land);

${mode === 'ocean'
    ? `  oTopS  = vec4(hT, Ts, St, 0.0);
  /* .zw is the lagged grad(eta) the ocean step stores for its Rhie-Chow face
     interpolation. The coupling pass must PRESERVE it -- zeroing it here would
     silently disable the checkerboard damping every other pass. */
  oTopV  = vec4(vt, tv.zw);
  oDeepS = vec4(Td, Sd, 0.0, 0.0);
  oDeepV = vec4(vd, 0.0, 0.0);`
    : `  oLoA = vec4(vl, Tl, Pl);
  oLoB = vec4(q , cloud, 0.0, 0.0);
  oHiA = vec4(vh, Th, Ph);
  oHiB = vec4(qh, rain, 0.0, 0.0);`}
}`;
}

var INIT_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oTopS;    // (h_top, T_top, S_top, _)
layout(location=1) out vec4 oTopV;    // (u_top, v_top, _, _)
layout(location=2) out vec4 oDeepS;   // (T_deep, S_deep, _, _)
layout(location=3) out vec4 oDeepV;   // (u_deep, v_deep, _, _)
uniform float uSeed, uHtop, uHtotal;
${CORI_FRIC_GLSL}

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  float lat = asin(clamp(n.y,-1.0,1.0));
  float c2 = cos(lat)*cos(lat);
  float rn = hash21(vec2(float(cell), uSeed))-0.5;
  float Ts = 273.0 + 28.0*c2 - 12.0*(1.0-c2) + rn*0.8;
  float Td = 275.0 + 6.0*c2 + rn*0.4;
  float S  = 34.7 + 1.2*cos(2.0*lat) + rn*0.2;
  /* Initialise to the cell's own reference thickness so the ocean starts at
     rest (eta = 0) everywhere, including over shelves. */
  oTopS  = vec4(clampH(cellHref(cell) + rn*0.5, cellD(cell)), Ts, S, 0.0);
  oTopV  = vec4(0.0);
  oDeepS = vec4(Td, S+0.3, 0.0, 0.0);
  oDeepV = vec4(0.0);
}`;

var INIT2_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oLoA;
layout(location=1) out vec4 oLoB;
layout(location=2) out vec4 oHiA;
layout(location=3) out vec4 oHiB;
uniform float uSeed;
${CORI_FRIC_GLSL}

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  float lat = asin(clamp(n.y,-1.0,1.0));
  float c2 = cos(lat)*cos(lat);
  float rn = hash21(vec2(float(cell), uSeed+7.0))-0.5;
  float Tl0 = 268.0 + 30.0*c2 + rn*1.2;
  float Th0 = 232.0 + 12.0*c2 + rn*0.6;
  float Pl0 = 101325.0 - 180.0*(Tl0 - 288.0) + 72.0*(Th0 - 250.0);
  float Ph0 = 45000.0  + 200.0*(0.5*(Tl0 + Th0) - 268.0);
  oLoA = vec4(rn*0.5, rn*0.5, Tl0, Pl0);
  oLoB = vec4(0.004*c2, 0.0, 0.0, 0.0);
  oHiA = vec4(rn*0.5, rn*0.5, Th0, Ph0);
  oHiB = vec4(0.0008*c2, 0.0, 0.0, 0.0);
}`;

var PART_FS = SHADER_HEAD + SHADER_COMMON + `
out vec4 oPart;
uniform sampler2D uPart, uLookup, uLoA, uTopV, uHiA, uDeepV;
uniform float uDt, uLife, uRadius, uSeed, uVelScale;
uniform int uVelMode;
uniform ivec2 uPDim;

vec3 randDir(float s){
  float a = hash11(s)*6.2831853;
  float z = hash11(s+91.7)*2.0-1.0;
  float r = sqrt(max(0.0,1.0-z*z));
  return vec3(r*cos(a), z, r*sin(a));
}

void main(){
  ivec2 t = ivec2(gl_FragCoord.xy);
  int pid = t.x + t.y*uPDim.x;
  vec4 p = texelFetch(uPart, t, 0);
  vec3 pos = p.xyz;
  float age = p.w;
  if(dot(pos,pos) < 0.1) pos = randDir(float(pid)+uSeed);
  pos = normalize(pos);

  float lon = atan(pos.z, pos.x);
  float lat = asin(clamp(pos.y,-1.0,1.0));
  vec2 uv = vec2(lon/6.2831853+0.5, lat/3.14159265+0.5);
  int cell = int(texture(uLookup, uv).r + 0.5);

  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 e1 = cb.xyz, e2 = cross(e1, pos);
  vec2 vel;
  if(uVelMode==0)      vel = texelFetch(uLoA, cTex(cell),0).xy;
  else if(uVelMode==1) vel = texelFetch(uTopV, cTex(cell),0).xy*uVelScale;
  else if(uVelMode==2) vel = texelFetch(uHiA, cTex(cell),0).xy;
  else                 vel = texelFetch(uDeepV, cTex(cell),0).xy*uVelScale;
  vec2 uvw = vel;
  vec3 v3 = uvw.x*e1 + uvw.y*e2;
  pos = normalize(pos + v3*uDt/uRadius);

  age -= uDt/uLife;
  if(age <= 0.0){
    pos = randDir(float(pid)*1.7 + uSeed*13.0);
    age = 1.0 + hash11(float(pid)+uSeed)*0.5;
  }
  oPart = vec4(pos, age);
}`;

var PART_VS = SHADER_HEAD + SHADER_COMMON + `
uniform sampler2D uPart, uLoA, uTopV, uHiA, uDeepV, uLookup;
uniform mat4 uMVP;
uniform ivec2 uPDim;
uniform float uTrail, uRadius, uEquirect, uVelScale, uAsPoints, uPointSize;
uniform int uVelMode;
out float vA;
void main(){
  int pid = (uAsPoints > 0.5) ? gl_VertexID : (gl_VertexID >> 1);
  int isTail = (uAsPoints > 0.5) ? 0 : (gl_VertexID & 1);
  ivec2 t = ivec2(pid % uPDim.x, pid / uPDim.x);
  vec4 p = texelFetch(uPart, t, 0);
  vec3 pos = normalize(p.xyz);
  float lon = atan(pos.z, pos.x), lat = asin(clamp(pos.y,-1.0,1.0));
  int cell = int(texture(uLookup, vec2(lon/6.2831853+0.5, lat/3.14159265+0.5)).r + 0.5);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 e1 = cb.xyz, e2 = cross(e1, pos);
  vec2 vel;
  if(uVelMode==0)      vel = texelFetch(uLoA, cTex(cell),0).xy;
  else if(uVelMode==1) vel = texelFetch(uTopV, cTex(cell),0).xy*uVelScale;
  else if(uVelMode==2) vel = texelFetch(uHiA, cTex(cell),0).xy;
  else                 vel = texelFetch(uDeepV, cTex(cell),0).xy*uVelScale;
  vec3 v3 = vel.x*e1 + vel.y*e2;                              // tangent velocity (m/s)
  // Back-step along the flow to draw a streak.  Clamp the angular extent so a
  // velocity spike (e.g. near coasts) or an oversized trail cannot fling the
  // tail far across the planet and paint a long stray line (globe mode bug).
  float s = length(v3) * (uTrail / uRadius);
  s = min(s, 0.35);                                           // ~20 deg cap
  vec3 tdir = (length(v3) > 1e-6) ? v3 / length(v3) : vec3(0.0);
  vec3 tail = normalize(pos - tdir * s);                      // arc back along flow
  vec3 outp = isTail == 1 ? tail : pos;
  vA = clamp(p.w,0.0,1.0) * clamp(1.5 - abs(p.w-0.5)*2.0, 0.0, 1.0);
  if(uEquirect > 0.5){
    vec2 uvHead = vec2(lon/6.2831853+0.5, lat/3.14159265+0.5);
    vec2 uvTail = vec2(atan(tail.z,tail.x)/6.2831853+0.5, asin(clamp(tail.y,-1.0,1.0))/3.14159265+0.5);
    // A streak that straddles the date line or a pole would be drawn as one
    // straight segment spanning the whole viewport.  Instead push the far
    // endpoint to the adjacent map edge so the streak stops at the boundary.
    bool wrap = abs(uvHead.x - uvTail.x) > 0.5 || abs(uvHead.y - uvTail.y) > 0.5;
    if (wrap) {
      if (abs(uvHead.x - uvTail.x) > 0.5) uvTail.x = uvHead.x > 0.5 ? 1.0 : 0.0;
      if (abs(uvHead.y - uvTail.y) > 0.5) uvTail.y = uvHead.y > 0.5 ? 1.0 : 0.0;
    }
    vec2 uv = (isTail == 1 ? uvTail : uvHead);
    gl_Position = vec4(uv*2.0 - 1.0, 0.0, 1.0);
  } else {
    gl_Position = uMVP * vec4(outp*1.012, 1.0);
  }
  gl_PointSize = uPointSize;
}`;

var PART_PS = SHADER_HEAD + `
in float vA; uniform vec3 uColor; uniform float uAsPoints; out vec4 o;
void main(){
  float a = vA * 0.75;
  if (uAsPoints > 0.5) {
    float d = length(gl_PointCoord - 0.5);
    a *= smoothstep(0.5, 0.15, d);
  }
  o = vec4(uColor, a);
}`;

function GLOBE_VS(m) {
return SHADER_HEAD + SHADER_COMMON + `
uniform sampler2D uTopS, uTopV, uDeepS, uDeepV, uLoA, uLoB, uHiA, uHiB;
uniform mat4 uMVP;
uniform float uRelief;
out vec3 vN; out float vVal; out float vLand; out float vCloud; out vec3 vPos;
${modeSampleFnSrc(m)}
void main(){
  int cell = gl_VertexID;
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  vec4 lb = texelFetch(uLoB, cTex(cell),0);
  vec4 hb = texelFetch(uHiB, cTex(cell),0);

  // Each vertex IS a simulation cell, so a raw per-vertex read reproduces the
  // hard Voronoi cell boundaries exactly (a per-FRAGMENT nearest-cell lookup
  // would be no better -- it removes the smooth barycentric blend the
  // rasteriser already gives across each triangle). Instead we pre-blend a
  // little of the 1-ring neighbourhood into each vertex value here: cheap (a
  // few extra texelFetch per vertex, not per pixel) and resolution-independent.
  float v0 = sampleVal(cell);
  float vAcc = 0.0, wAcc = 0.0;
  for(int k=0;k<6;k++){
    vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
    if(na.w < 0.5) continue;
    vAcc += sampleVal(int(na.x));
    wAcc += 1.0;
  }
  float v = wAcc > 0.0 ? mix(v0, vAcc/wAcc, 0.35) : v0;

  vVal = clamp(v, 0.0, 1.0);
  vLand = cb.w;
  vCloud = clamp(lb.y + hb.y*0.5, 0.0, 1.0);
  vN = n;
  vPos = n*(1.0 + uRelief*cb.w);
  gl_Position = uMVP*vec4(vPos, 1.0);
}`;
}

function GLOBE_FS(m) {
return SHADER_HEAD + `
in vec3 vN; in float vVal; in float vLand; in float vCloud; in vec3 vPos;
uniform vec3 uSun; uniform vec3 uEye;
uniform float uShowLand, uNight;
out vec4 o;
vec3 pal(float t){
  t = clamp(t,0.0,1.0);
  vec3 c0=vec3(0.05,0.02,0.25), c1=vec3(0.05,0.35,0.75), c2=vec3(0.10,0.75,0.65),
       c3=vec3(0.85,0.85,0.25), c4=vec3(0.90,0.35,0.10), c5=vec3(0.65,0.05,0.12);
  if(t<0.2) return mix(c0,c1,t/0.2);
  if(t<0.4) return mix(c1,c2,(t-0.2)/0.2);
  if(t<0.6) return mix(c2,c3,(t-0.4)/0.2);
  if(t<0.8) return mix(c3,c4,(t-0.6)/0.2);
  return mix(c4,c5,(t-0.8)/0.2);
}
void main(){
  vec3 base = pal(vVal);
${modeMagSrc(m)}
${modeLandSrc(m)}
  vec3 N = normalize(vN);
  float d = max(0.0, dot(N, uSun));
  float lit = mix(1.0, 0.16 + 0.9*d, uNight);
${modeLitSrc(m)}
  vec3 V = normalize(uEye - vPos);
  float rim = pow(1.0 - max(0.0,dot(N,V)), 3.0);
  vec3 col = base*lit + vec3(0.20,0.42,0.85)*rim*0.55;
  o = vec4(col, 1.0);
}`;
}

var CLOUD_VS = SHADER_HEAD + SHADER_COMMON + `
uniform sampler2D uLoB, uHiB;
uniform mat4 uMVP;
uniform float uShellR;
out float vC; out float vR; out vec3 vN;
void main(){
  int cell = gl_VertexID;
  vec3 n = normalize(texelFetch(uCellA, cTex(cell),0).xyz);
  // 1-ring pre-blend, as in GLOBE_VS: softens hex faceting of the cloud deck.
  float c0 = texelFetch(uLoB, cTex(cell),0).y;
  float r0 = texelFetch(uHiB, cTex(cell),0).y;
  float cAcc = 0.0, rAcc = 0.0, wAcc = 0.0;
  for(int k=0;k<6;k++){
    vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
    if(na.w < 0.5) continue;
    int j = int(na.x);
    cAcc += texelFetch(uLoB, cTex(j),0).y;
    rAcc += texelFetch(uHiB, cTex(j),0).y;
    wAcc += 1.0;
  }
  vC = clamp(wAcc > 0.0 ? mix(c0, cAcc/wAcc, 0.4) : c0, 0.0, 1.0);
  vR = clamp(wAcc > 0.0 ? mix(r0, rAcc/wAcc, 0.4) : r0, 0.0, 2.0);
  vN = n;
  gl_Position = uMVP*vec4(n*uShellR, 1.0);
}`;

var CLOUD_FS = SHADER_HEAD + `
in float vC; in float vR; in vec3 vN;
uniform vec3 uSun; uniform float uNight;
out vec4 o;
void main(){
  float a = clamp(vC*0.9 + vR*0.35, 0.0, 1.0);
  if(a < 0.02) discard;
  float d = max(0.0, dot(normalize(vN), uSun));
  float lit = mix(1.0, 0.22 + 0.85*d, uNight);
  vec3 c = mix(vec3(1.0), vec3(0.45,0.5,0.62), clamp(vR*0.5,0.0,0.75));
  o = vec4(c*lit, a*0.85);
}`;
