/* shader.js - all GLSL program sources (WebGL2 / GLSL ES 3.00) */
var SHADER_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

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
  'ht/1200.0',                             // 15 top-layer thickness h_top (m)
  'dep/uMaxDepth',                         // 16 sea-floor depth (m)
];
// modes that use magnitude (dark-background) coloring; palette-color fields excluded
var MODE_MAG = { 3:1, 4:1, 5:1, 6:1, 11:1, 12:1, 13:1 };
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
  float dep = texelFetch(uBathy, cTex(cell),0).x;
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

var SHADER_COMMON = `
uniform ivec2 uDim;          // W, H of the cell texture
uniform int   uCount;        // number of real cells (V)
uniform sampler2D uCellA;    // pos.xyz , area
uniform sampler2D uCellB;    // east.xyz, land
uniform sampler2D uNbrA;     // idx , edgeLen , dist , valid
uniform sampler2D uNbrB;     // nx , ny , rotA , rotB
uniform sampler2D uBathy;    // depth , refHTop , seaLevel , rawHeight  (STATIC)
uniform sampler2D uLand;     // dynamic land mask in .x  (one snapshot per step)
uniform float uMaxDepth;     // deepest sea floor [m], for normalising depth views

// Shared clamp margin for the top/deep layer thicknesses: every cell is
// guaranteed depth >= 30 m by the mesh generator, so [MARG, D-MARG] is a
// non-empty interval everywhere.
const float MARG = 5.0;

ivec2 cTex(int i){ int y = i / uDim.x; return ivec2(i - y*uDim.x, y); }
ivec2 nTex(int i,int k){ int y = i / uDim.x; return ivec2(i - y*uDim.x, y + k*uDim.y); }

float cellDepth(int i){ return texelFetch(uBathy, cTex(i), 0).x; }   // sea-floor depth [m]
float cellHref (int i){ return texelFetch(uBathy, cTex(i), 0).y; }   // reference h_top [m]
float cellLand (int i){ return texelFetch(uLand , cTex(i), 0).x; }   // dynamic land mask

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

${modeValueSrc(m)}
  float vVal = clamp(v, 0.0, 1.0);
  float vLand = cellLand(cell);

  vec3 base = pal(vVal);
${modeMagSrc(m)}
  base = mix(base, base*vec3(0.72,0.88,0.62)+vec3(0.10,0.09,0.02), uShowLand*vLand*0.45);

  // day/night uses the real cell normal (blocky, crisp) — not a smooth reconstruction
  vec3 n = normalize(ca.xyz);
  float d = max(0.0, dot(n, uSun));
  float lit = mix(1.0, 0.16 + 0.9*d, uNight);

  vec3 col = base * lit;
  o = vec4(col, 1.0);
}`;
}

var EQUI_CLOUD_FS = SHADER_HEAD + SHADER_COMMON + `
uniform sampler2D uLookup, uCellA, uLoB, uHiB;
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
   h_deep = depth(cell) - h_top is DERIVED from the STATIC per-cell bathymetry
   (uBathy.x), so the total ocean volume sum(D*area) is fixed by construction
   and only the interface between the two layers moves.

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
uniform float uDrag;         // effective inter-layer drag coeff (kg/m^3/s)
uniform float uStratDrag;    // 0 = constant drag, 1 = full Richardson suppression
uniform float uBottomCd;     // quadratic bottom-drag coefficient (dimensionless)
uniform float uSteric, uStericRate; // buoyancy -> equilibrium thickness, and its rate
uniform float uMassSpring;   // weak global mass correction (1/s)

const float A_RI   = 5.0;    // Pacanowski-Philander shape parameter
const float MIN_HD = 10.0;   // depth floor in the bottom-stress denominator [m]

// Buoyancy anomaly of a layer: positive = warm/fresh = light.
float buoy(float T, float S){ return uAlphaT*(T-283.0) - uBetaS*(S-35.0); }

// Reduced gravity from the instantaneous T/S contrast between the layers.
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
  vec3 n = normalize(ca.xyz);
  float area = ca.w;
  float land = cellLand(cell);          // dynamic mask: one snapshot per step
  float D    = cellDepth(cell);         // per-cell sea-floor depth [m]
  float href = cellHref(cell);          // per-cell reference top thickness [m]

  vec4  ts0 = texelFetch(uTopS , cTex(cell), 0);   // (h, T, S, _)
  vec2  vt0 = texelFetch(uTopV , cTex(cell), 0).xy;
  vec4  ds0 = texelFetch(uDeepS, cTex(cell), 0);   // (T, S, _, _)
  vec2  vd0 = texelFetch(uDeepV, cTex(cell), 0).xy;
  float h0  = ts0.x;
  float hd0 = D - h0;
  vec2  trT0 = ts0.yz;          // (T_top,  S_top)
  vec2  trD0 = ds0.xy;          // (T_deep, S_deep)

  float gp = gPrime(ts0.y, ts0.z, ds0.x, ds0.y);

  float divF = 0.0;             // div(h_top*u_top): the mass flux
  float divT = 0.0, divD = 0.0; // div(u) per layer (advective-form correction)
  vec2  gradH = vec2(0.0);      // grad(h_top)
  vec2  gradHr = vec2(0.0);     // grad(h_ref): the PERMANENT reference gradient
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
    float landj = cellLand(j);
    float wet = (1.0-landj)*(1.0-land);      // no flow through coastlines

    vtj = xfer(vtj, nb.z, nb.w) * (1.0-landj);
    vdj = xfer(vdj, nb.z, nb.w) * (1.0-landj);

    // face-normal velocities (the SAME quantities used by every operator below)
    float unT = 0.5*dot(vt0+vtj, nrm)*wet;
    float unD = 0.5*dot(vd0+vdj, nrm)*wet;

    // --- CONTINUITY: mass flux through this face = L * h_face * u_n --------
    float hFace = 0.5*(h0 + tsj.x);
    divF += L*hFace*unT;
    divT += L*unT;
    divD += L*unD;

    // sea-surface-height gradient (Gauss), drives both layers (opposite signs)
    gradH  += L*0.5*(tsj.x - h0)*nrm*wet;
    // same FV stencil for the static reference thickness, so the permanent
    // bathymetric part of grad(h_top) can be subtracted below (perturbation form)
    gradHr += L*0.5*(cellHref(j) - href)*nrm*wet;

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
  divF *= ia; divT *= ia; divD *= ia; gradH *= ia; gradHr *= ia;
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
  float hEq = href + uSteric*buoy(ts0.y, ts0.z);
  hEq = clamp(hEq, MARG, D - MARG);
  float h1 = h0 - uDt*divF
                - uDt*uStericRate*(h0 - hEq)
                - uDt*uMassSpring*(h0 - href);
  h1 = clamp(h1, MARG, D - MARG);
  if(isnan(h1)) h1 = h0;
  float hd1 = D - h1;

  // ---- MOMENTUM ----------------------------------------------------------
  // PERTURBATION-FORM pressure gradient.  h_ref is now per-cell, so it carries
  // a PERMANENT spatial gradient of order tens of metres.  Driving the layers
  // with grad(h_top) directly would turn that static bathymetric signal into a
  // permanent, clamp-saturating geostrophic current.  Both layers therefore
  // see only the DYNAMIC departure grad(h_top - h_ref); a state at rest with
  // h_top == h_ref feels exactly zero force, while the steric circulation
  // (which is an anomaly about h_ref) is preserved unchanged.
  vec2 gradP = gradH - gradHr;
  vec2 accT = -9.81*gradP + uNuVel*lapVt - advVt + vt0*divT;
  vec2 accD = +gp  *gradP + uNuVel*lapVd - advVd + vd0*divD;

  // inter-layer stress, EQUAL AND OPPOSITE, inverse-column-mass weighted:
  //   d(rho*h_top*u_top + rho*h_deep*u_deep)/dt = -tau + tau = 0
  // The coefficient is now stratification dependent: with a bulk Richardson
  // number Ri = g'*h_top/|du|^2 a strong pycnocline (large Ri) suppresses the
  // vertical momentum exchange in Pacanowski-Philander form 1/(1+a*Ri)^2,
  // while weakly stratified / strongly sheared columns keep the full drag.
  vec2  dv   = vt0 - vd0;
  float dvm  = length(dv);
  float Ri   = max(gp, 0.0)*max(h1, MARG)/max(dvm*dvm, 1e-6);
  float supp = 1.0/(1.0 + A_RI*max(Ri, 0.0));
  supp = supp*supp;
  float dragEff = uDrag*mix(1.0, supp, clamp(uStratDrag, 0.0, 1.0));
  vec2  tau = dragEff*dvm*dv;                       // N/m^2
  accT -= tau/(1027.0*max(h1 , MARG));
  accD += tau/(1027.0*max(hd1, MARG));

  // Bottom friction: quadratic bottom stress spread over the deep layer,
  //   dv/dt = -Cd*|v|*v/h_deep  ->  linearised rate r = Cd*|v|/h_deep.
  // Shallow shelves damp in hours-to-days, the abyss in hundreds of days,
  // instead of the old depth-independent constant.
  float fricDeepEff = uFricDeep + uBottomCd*length(vd0)/max(hd1, MIN_HD);

  // Coriolis: SEMI-IMPLICIT 2x2 rotation solve.  Forward Euler injects
  // energy every step (~3%/step at default spin, ~64%/step at max), which was
  // previously only hidden by the velocity clamp.  The (1+(dt*f)^2) denominator
  // makes the rotation exactly energy conserving and unconditionally stable.
  //
  // SIGN: the tangent basis is e1 = norm(cross(n, AXIS)), e2 = cross(e1, n),
  // so e1 x e2 = -n -- it is LEFT handed, not the usual east/north/up. Working
  // -2*Omega x v out in this basis gives acc = (-f*w, +f*u), NOT the textbook
  // (+f*w, -f*u), so the off-diagonal terms below are flipped accordingly.
  // Getting this backwards silently mirrors every gyre and jet.
  float fc = 2.0*uOmega*n.y;
  float fd = uDt*fc;
  float fden = 1.0 + fd*fd;

  vec2 pT = vt0 + uDt*accT;
  vec2 pD = vd0 + uDt*accD;
  vec2 vt1 = vec2(pT.x - fd*pT.y, pT.y + fd*pT.x)/(fden*(1.0 + uDt*uFricTop));
  vec2 vd1 = vec2(pD.x - fd*pD.y, pD.y + fd*pD.x)/(fden*(1.0 + uDt*fricDeepEff));
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
    float f = clamp(dEnt/max(h1, MARG), 0.0, 1.0);
    trT1 += f*(trD1 - trT1);
  } else if(dEnt < 0.0){   // interface shoals: top water is detrained downward
    float f = clamp(-dEnt/max(hd1, MARG), 0.0, 1.0);
    trD1 += f*(trT1 - trD1);
  }

  oTopS  = vec4(h1, trT1.x, trT1.y, 0.0);
  oTopV  = vec4(vt1, 0.0, 0.0);
  oDeepS = vec4(trD1.x, trD1.y, 0.0, 0.0);
  oDeepV = vec4(vd1, 0.0, 0.0);
}`;

var AIR_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oLoA;
layout(location=1) out vec4 oLoB;
layout(location=2) out vec4 oHiA;
layout(location=3) out vec4 oHiB;

uniform sampler2D uLoA, uLoB, uHiA, uHiB;
uniform float uDt, uOmega, uNuVel, uNuT, uFricLo, uFricHi, uRhoLo, uRhoHi;

void stepAir(int cell, vec3 n, float area, float land,
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
  float div = 0.0;

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
    float un = 0.5*dot(v0+vj, nrm);
    div += L*un;
    float w = un > 0.0 ? 0.0 : 1.0;
    advT += L*un*mix(tr0, trj, w);
    advV += L*un*mix(v0,  vj,  w);
  }

  float ia = 1.0/area;
  gradP *= ia; lapV *= ia; lapT *= ia; advV *= ia; advT *= ia; div *= ia;

  vec2 acc = -gradP/rho + uNuVel*lapV - advV + v0*div;

  // Semi-implicit (energy-conserving) Coriolis, same 2x2 solve as the ocean.
  // Same left-handed-basis sign convention: acc = (-f*w, +f*u).
  float f = fric*(1.0 + 2.0*land);
  float fc = 2.0*uOmega*n.y;
  float fd = uDt*fc;
  vec2  pv = v0 + uDt*acc;
  vec2  v1 = vec2(pv.x - fd*pv.y, pv.y + fd*pv.x)/((1.0 + fd*fd)*(1.0 + uDt*f));
  v1 = clamp(v1, vec2(-90.0), vec2(90.0));

  vec3 tr1 = tr0 + uDt*(uNuT*lapT - advT + tr0*div);
  tr1.x = clamp(tr1.x, 150.0, 360.0);
  tr1.y = clamp(tr1.y, 0.0, 0.08);
  tr1.z = clamp(tr1.z, 0.0, 4.0);
  if(any(isnan(v1))) v1 = vec2(0.0);
  if(any(isnan(tr1))) tr1 = tr0;

  outA = vec4(v1, tr1.x, p0);
  outB = vec4(tr1.y, tr1.z, b0.z, b0.w);
}

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  if(cell >= uCount){ oLoA=vec4(0.0); oLoB=vec4(0.0); oHiA=vec4(0.0); oHiB=vec4(0.0); return; }
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  float land = cellLand(cell);
  stepAir(cell, n, ca.w, land, uLoA, uLoB, uFricLo, uRhoLo, oLoA, oLoB);
  stepAir(cell, n, ca.w, land, uHiA, uHiB, uFricHi, uRhoHi, oHiA, oHiB);
}`;

/* Coupling pass. Compiled twice (ocean / air): both variants read all 8 state
   textures but each writes only its own <= 4 attachments.

   Conservation invariants (per cell):
     MASS      h_top + h_deep = depth(cell) exactly (h_deep is derived);
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

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  float land = cellLand(cell);       // SAME snapshot the dynamics passes used
  float D    = cellDepth(cell);
  float lat = asin(clamp(n.y,-1.0,1.0));

  vec4 ts = texelFetch(uTopS , cTex(cell), 0);   // (h_top, T_top, S_top, _)
  vec4 ds = texelFetch(uDeepS, cTex(cell), 0);   // (T_deep, S_deep, _, _)
  vec2 vt = texelFetch(uTopV , cTex(cell), 0).xy;
  vec2 vd = texelFetch(uDeepV, cTex(cell), 0).xy;
  vec4 la = texelFetch(uLoA , cTex(cell), 0);
  vec4 lb = texelFetch(uLoB , cTex(cell), 0);
  vec4 ha = texelFetch(uHiA , cTex(cell), 0);
  vec4 hb = texelFetch(uHiB , cTex(cell), 0);

  float hT = clamp(ts.x, MARG, D-MARG);
  float hD = D - hT;
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
  hT = clamp(hT - uDt*(EmP/rhoW + uSurfMass*(1.0-land)), MARG, D-MARG);
  hD = D - hT;
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
  // The mixing efficiency still responds to the stratification: instability of
  // EITHER sign stirs the column (surface cooling/salting sinks; a locally
  // denser deep layer upwells), but the exchanges themselves are written in
  // content form so nothing is created or destroyed.
  float rt = -0.00017*(Ts-283.0) + 0.00078*(St-35.0);
  float rd = -0.00017*(Td-283.0) + 0.00078*(Sd-35.0);
  float stab = 1.0 + 900.0*abs(rt-rd);

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
  Tl += uNoise*nz;

  float Pl = 101325.0 - 60.0*(Tl - 288.0) + 25.0*(Th - 250.0);
  float Ph = 45000.0  + 75.0*(0.5*(Tl + Th) - 268.0);

  Ts = clamp(Ts, 200.0, 360.0);  Td = clamp(Td, 200.0, 360.0);
  Tl = clamp(Tl, 150.0, 360.0);  Th = clamp(Th, 150.0, 360.0);
  St = clamp(St, 5.0, 60.0);     Sd = clamp(Sd, 5.0, 60.0);
  q  = clamp(q , 0.0, 0.08);     qh = clamp(qh, 0.0, 0.08);
  vt *= (1.0-land);              vd *= (1.0-land);

${mode === 'ocean'
    ? `  oTopS  = vec4(hT, Ts, St, 0.0);
  oTopV  = vec4(vt, 0.0, 0.0);
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
uniform float uSeed;
void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  float lat = asin(clamp(n.y,-1.0,1.0));
  float c2 = cos(lat)*cos(lat);
  float rn = hash21(vec2(float(cell), uSeed))-0.5;
  float Ts = 273.0 + 28.0*c2 - 12.0*(1.0-c2) + rn*0.8;
  float Td = 275.0 + 6.0*c2 + rn*0.4;
  float S  = 34.7 + 1.2*cos(2.0*lat) + rn*0.2;
  // Seed the interface at the per-cell reference thickness, so the model
  // starts in the state the perturbation-form PGF regards as "at rest".
  float D    = max(cellDepth(cell), 2.0*MARG + 1.0);
  float href = cellHref(cell);
  oTopS  = vec4(clamp(href + rn*0.5, MARG, D-MARG), Ts, S, 0.0);
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
void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  float lat = asin(clamp(n.y,-1.0,1.0));
  float c2 = cos(lat)*cos(lat);
  float rn = hash21(vec2(float(cell), uSeed+7.0))-0.5;
  oLoA = vec4(rn*0.5, rn*0.5, 268.0 + 30.0*c2 + rn*1.2, 101325.0);
  oLoB = vec4(0.004*c2, 0.0, 0.0, 0.0);
  oHiA = vec4(rn*0.5, rn*0.5, 232.0 + 12.0*c2 + rn*0.6, 45000.0);
  oHiB = vec4(0.0008*c2, 0.0, 0.0, 0.0);
}`;

/* ---------------------------------------------------------------------------
   DYNAMIC COASTLINE.  Writes the land mask texture that every other pass then
   READS (uLand).  It is deliberately a separate, throttled pass:

   HARD TIMING RULE - the mask is recomputed ONLY at a step boundary, after the
   ocean dynamics, air dynamics and coupling passes of that step have all
   finished.  Within one step every pass therefore sees the exact same land
   snapshot; a cell can never be "ocean" for the dynamics (advecting h_top,
   exchanging momentum and heat) and "land" for the coupling, which would
   create spurious mass/heat sources or NaNs.

   It writes ONLY the mask, never a state texture: a flipping cell keeps its
   h_top untouched and simply stops advecting (velocities are multiplied by
   1-land everywhere), then relaxes toward its local refHTop.  Continents
   (cellB.w) are always land, whatever h_top does. */
var MASK_FS = SHADER_HEAD + SHADER_COMMON + `
out vec4 oMask;
uniform sampler2D uTopS;
uniform float uFloodMargin, uFloodTrans;
void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  float base = texelFetch(uCellB, cTex(cell), 0).w;   // static continent base
  float D    = cellDepth(cell);
  float ht   = texelFetch(uTopS, cTex(cell), 0).x;
  // Water column left underneath the top layer; a shallow cell dries out when
  // the top layer no longer fits inside the local depth.
  float flood = smoothstep(uFloodMargin, uFloodMargin + uFloodTrans, D - ht);
  float land = clamp(max(base, 1.0 - flood), 0.0, 1.0);
  if(isnan(land)) land = base;
  oMask = vec4(land, 0.0, 0.0, 0.0);
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
  vLand = cellLand(cell);
  vCloud = clamp(lb.y + hb.y*0.5, 0.0, 1.0);
  vN = n;
  vPos = n*(1.0 + uRelief*vLand);
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
  base = mix(base, base*vec3(0.72,0.88,0.62)+vec3(0.10,0.09,0.02), uShowLand*vLand*0.45);
  vec3 N = normalize(vN);
  float d = max(0.0, dot(N, uSun));
  float lit = mix(1.0, 0.16 + 0.9*d, uNight);
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
