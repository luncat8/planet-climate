/* shader.js - all GLSL program sources (WebGL2 / GLSL ES 3.00) */
/* Hard clamp on the sea-surface height anomaly [m]. Shared by the simulation
   (OCEAN_LAYERS -> ETA_MAX) and by the SSH render mode's normalisation, so the
   two can never drift apart. */
var ETA_MAX = 60;

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
  'we.x/' + ETA_MAX.toFixed(1) + '*0.5+0.5', // 15 sea-surface height (eta, +/-ETA_MAX)
];
// modes that use magnitude (dark-background) coloring; palette-color fields excluded
var MODE_MAG = { 3:1, 4:1, 5:1, 6:1, 11:1, 12:1, 13:1 };
function modeValueSrc(m) {
  return 'float v = ' + (MODE_FIELDS[m] != null ? MODE_FIELDS[m] : MODE_FIELDS[9]) + ';';
}
/* Same per-mode expression, wrapped as a function of an arbitrary cell index so
   the globe vertex shader can also sample its 1-ring neighbours and pre-blend
   them (softens hex faceting without a per-fragment nearest-cell lookup). */
function modeSampleFnSrc(m) {
  return 'float sampleVal(int cell){\n' +
    '  vec4 wt = texelFetch(uTop,  cTex(cell),0);\n' +
    '  vec4 la = texelFetch(uLoA,  cTex(cell),0);\n' +
    '  vec4 lb = texelFetch(uLoB,  cTex(cell),0);\n' +
    '  vec4 ha = texelFetch(uHiA,  cTex(cell),0);\n' +
    '  vec4 hb = texelFetch(uHiB,  cTex(cell),0);\n' +
    '  vec4 wd = texelFetch(uDeep, cTex(cell),0);\n' +
    '  vec4 we = texelFetch(uEta,  cTex(cell),0);\n' +
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

ivec2 cTex(int i){ int y = i / uDim.x; return ivec2(i - y*uDim.x, y); }
ivec2 nTex(int i,int k){ int y = i / uDim.x; return ivec2(i - y*uDim.x, y + k*uDim.y); }

vec2 xfer(vec2 v, float ra, float rb){ return vec2(ra*v.x - rb*v.y, rb*v.x + ra*v.y); }

float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

float qsat(float T, float P){
  float es = 611.2*exp(17.67*(T-273.15)/max(T-29.65, 20.0));
  return clamp(0.622*es/max(P-0.378*es, 100.0), 0.0, 0.08);
}
`;

/* Two-layer ocean geometry, shared by the dynamics and coupling passes so both
   agree on exactly how the prognostic sea-surface height eta maps onto layer
   thicknesses. The TOTAL ocean depth is a hard constant: whatever the top layer
   gains, the deep layer loses. */
var OCEAN_LAYERS = `
const float H_TOP0  = 200.0;    // reference top-layer thickness [m]
const float H_DEEP0 = 800.0;    // reference deep-layer thickness [m]
const float H_TOTAL = 1000.0;   // fixed total depth  [m]
const float ETA_MAX = ${ETA_MAX.toFixed(1)};     // |eta| clamp keeps both layers safely thick
const float RHO0    = 1027.0;   // reference sea-water density [kg/m^3]
const float CP_W    = 3990.0;   // sea-water heat capacity [J/(kg K)]
float hTopOf (float eta){ return clamp(H_TOP0 + eta, 20.0, H_TOTAL-20.0); }
float hDeepOf(float eta){ return H_TOTAL - hTopOf(eta); }
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
uniform sampler2D uTop, uDeep, uLoA, uLoB, uHiA, uHiB, uEta, uLookup;
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

  vec4 wt = texelFetch(uTop,  cTex(cell),0);
  vec4 la = texelFetch(uLoA,  cTex(cell),0);
  vec4 lb = texelFetch(uLoB,  cTex(cell),0);
  vec4 ha = texelFetch(uHiA,  cTex(cell),0);
  vec4 hb = texelFetch(uHiB,  cTex(cell),0);
  vec4 ca = texelFetch(uCellA,cTex(cell),0);
  vec4 cb = texelFetch(uCellB,cTex(cell),0);
  vec4 wd = texelFetch(uDeep, cTex(cell),0);
  vec4 we = texelFetch(uEta,  cTex(cell),0);

${modeValueSrc(m)}
  float vVal = clamp(v, 0.0, 1.0);
  float vLand = cb.w;

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

var OCEAN_FS = SHADER_HEAD + SHADER_COMMON + OCEAN_LAYERS + `
layout(location=0) out vec4 oTop;
layout(location=1) out vec4 oDeep;
layout(location=2) out vec4 oEta;

uniform sampler2D uTop;
uniform sampler2D uDeep;
uniform sampler2D uEta;        // .r = sea-surface height anomaly eta [m]
uniform float uDt, uOmega, uNuVel, uNuT, uFricTop, uFricDeep, uAlphaT, uBetaS;
uniform float uPkTop, uPkDeep, uPkAbyss;
uniform float uGBaro;          // rho0*g*sshGain -- barotropic pressure per metre of eta
uniform float uDragI;          // inter-layer mechanical drag coefficient [m/s]
uniform float uMassFix;        // weak global volume-drift relaxation [1/s]

// buoyancy anomaly: positive = warm/fresh = light
float buoy(vec4 s){ return uAlphaT*(s.x-283.0) - uBetaS*(s.w-35.0); }

// Top-layer pressure = barotropic (free-surface) part + the classic
// reduced-gravity steric part from its OWN buoyancy (warm/light water piles up).
float oceanPTop(vec4 sTop, float eta){ return uGBaro*eta + uPkTop*buoy(sTop); }

// Deep layer: hydrostatic pressure at depth carries the SAME barotropic term
// (the free surface tilts the whole column), minus the *compensating* weight of
// whatever sits above it -- a light/warm top layer means LESS weight overhead,
// hence LOWER pressure beneath it. That sign flip is what closes the
// overturning into a genuine return limb; a small direct term from the deep
// water's own density adds slow abyssal drift. Both baroclinic terms are scaled
// by the live layer thicknesses, so a thicker warm lens pushes harder.
float oceanPDeep(vec4 sDeep, vec4 sTop, float eta, float hTop, float hDeep){
  return uGBaro*eta
       - uPkDeep *buoy(sTop) *(hTop /H_TOP0)
       + uPkAbyss*buoy(sDeep)*(hDeep/H_DEEP0);
}

// One conservative finite-volume update of BOTH ocean layers plus the free
// surface. Doing them together (instead of once per layer) is what makes the
// conservation laws exact: the same face fluxes are reused by the continuity,
// heat/salt and momentum budgets, and the inter-layer drag is applied as a
// single equal-and-opposite pair.
void stepOcean(int cell, vec3 n, vec3 e1, vec3 e2, float area, float land,
               out vec4 outTop, out vec4 outDeep, out vec4 outEta)
{
  vec4  top0  = texelFetch(uTop , cTex(cell), 0);
  vec4  deep0 = texelFetch(uDeep, cTex(cell), 0);
  float eta0  = texelFetch(uEta , cTex(cell), 0).r;

  float hTop0  = hTopOf(eta0);
  float hDeep0 = hDeepOf(eta0);

  vec2 vT0 = top0.yz, vD0 = deep0.yz;
  float pT0 = oceanPTop(top0, eta0);
  float pD0 = oceanPDeep(deep0, top0, eta0, hTop0, hDeep0);

  vec2 gradPT = vec2(0.0), lapVT = vec2(0.0), advVT = vec2(0.0);
  vec2 gradPD = vec2(0.0), lapVD = vec2(0.0), advVD = vec2(0.0);
  // thickness-weighted (i.e. genuinely conservative) tracer fluxes
  float divT = 0.0, advHT_T = 0.0, advHS_T = 0.0, lapHT_T = 0.0, lapHS_T = 0.0;
  float divD = 0.0, advHT_D = 0.0, advHS_D = 0.0, lapHT_D = 0.0, lapHS_D = 0.0;
  // The tracer/continuity budgets need the VOLUME divergence div(h*u), but the
  // momentum stretching term pairs with the unweighted advection operator
  // div(u*v) and therefore needs the plain velocity divergence div(u). Mixing
  // the two would leave a spurious residual wherever the layer thickness varies.
  float divU_T = 0.0, divU_D = 0.0;

  // ---- THE GATHER LOOP: 6 (or 5) neighbours via the baked wrap table ----
  for(int k=0;k<6;k++){
    vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
    if(na.w < 0.5) continue;                 // pentagon: only 5 neighbours
    int   j = int(na.x);
    float L = na.y;                          // Voronoi edge length  [m]
    float d = na.z;                          // centre distance      [m]
    vec4  nb = texelFetch(uNbrB, nTex(cell,k), 0);
    vec2  nrm = nb.xy;                       // unit outward normal (local basis)

    vec4  topj  = texelFetch(uTop , cTex(j), 0);
    vec4  deepj = texelFetch(uDeep, cTex(j), 0);
    float etaj  = texelFetch(uEta , cTex(j), 0).r;
    float landj = texelFetch(uCellB,cTex(j), 0).w;
    float wet   = (1.0-landj)*(1.0-land);    // no flow through coastlines

    float hTopj  = hTopOf(etaj);
    float hDeepj = hDeepOf(etaj);

    vec2 vTj = xfer(topj.yz , nb.z, nb.w) * (1.0-landj);
    vec2 vDj = xfer(deepj.yz, nb.z, nb.w) * (1.0-landj);

    float pTj = oceanPTop(topj, etaj);
    float pDj = oceanPDeep(deepj, topj, etaj, hTopj, hDeepj);

    gradPT += L*0.5*(pTj-pT0)*nrm*wet;       // Gauss gradient
    gradPD += L*0.5*(pDj-pD0)*nrm*wet;
    lapVT  += (L/d)*(vTj-vT0)*wet;           // FV Laplacian
    lapVD  += (L/d)*(vDj-vD0)*wet;

    // --- top layer face fluxes: volume, heat, salt (all share one face vel) ---
    float unT = 0.5*dot(vT0+vTj, nrm)*wet;   // face normal velocity
    float wT  = unT > 0.0 ? 0.0 : 1.0;       // 1st order upwind
    float hfT = mix(hTop0, hTopj, wT);       // upwind thickness
    divT    += L*unT*hfT;
    divU_T  += L*unT;
    advHT_T += L*unT*hfT*mix(top0.x, topj.x, wT);
    advHS_T += L*unT*hfT*mix(top0.w, topj.w, wT);
    lapHT_T += (L/d)*(hTopj*topj.x - hTop0*top0.x);
    lapHS_T += (L/d)*(hTopj*topj.w - hTop0*top0.w);
    advVT   += L*unT*mix(vT0, vTj, wT);

    // --- deep layer face fluxes ---
    float unD = 0.5*dot(vD0+vDj, nrm)*wet;
    float wD  = unD > 0.0 ? 0.0 : 1.0;
    float hfD = mix(hDeep0, hDeepj, wD);
    divD    += L*unD*hfD;
    divU_D  += L*unD;
    advHT_D += L*unD*hfD*mix(deep0.x, deepj.x, wD);
    advHS_D += L*unD*hfD*mix(deep0.w, deepj.w, wD);
    lapHT_D += (L/d)*(hDeepj*deepj.x - hDeep0*deep0.x);
    lapHS_D += (L/d)*(hDeepj*deepj.w - hDeep0*deep0.w);
    advVD   += L*unD*mix(vD0, vDj, wD);
  }

  float ia = 1.0/area;
  gradPT *= ia; lapVT *= ia; advVT *= ia;
  divT *= ia; divU_T *= ia; advHT_T *= ia; advHS_T *= ia; lapHT_T *= ia; lapHS_T *= ia;
  gradPD *= ia; lapVD *= ia; advVD *= ia;
  divD *= ia; divU_D *= ia; advHT_D *= ia; advHS_D *= ia; lapHT_D *= ia; lapHS_D *= ia;

  // ---- 1. MASS / VOLUME: discrete continuity for the free surface ----------
  // d(eta)/dt = -div(h_top * u_top). The total depth H_TOTAL is a hard
  // constant, so the deep thickness is purely DIAGNOSTIC: h_deep = H_TOTAL -
  // h_top. That is the usual two-layer interface displacement, and it means the
  // deep layer's own transport divergence (divD) is NOT what sets its
  // thickness -- divD is used only for its momentum and tracer fluxes, whose
  // conserved quantity is the content h*T, not T itself.
  float eta1 = eta0 - uDt*divT;
  eta1 -= uMassFix*eta1*uDt;                 // weak global mass-drift damper
  eta1 = clamp(eta1, -ETA_MAX, ETA_MAX);
  if(isnan(eta1)) eta1 = 0.0;
  eta1 = mix(eta1, 0.0, land);               // no free surface over land
  float hTop1  = hTopOf(eta1);
  float hDeep1 = hDeepOf(eta1);

  // ---- 3. HEAT / SALT: advance the *content* h*T and h*S, then divide -------
  // Because the flux divergence telescopes across faces (each face is counted
  // once with opposite signs by its two cells), the global sum of h*T and h*S
  // is unchanged by advection and diffusion alone.
  float hT_T = hTop0 *top0.x  + uDt*(uNuT*lapHT_T - advHT_T);
  float hS_T = hTop0 *top0.w  + uDt*(uNuT*lapHS_T - advHS_T);
  float hT_D = hDeep0*deep0.x + uDt*(uNuT*lapHT_D - advHT_D);
  float hS_D = hDeep0*deep0.w + uDt*(uNuT*lapHS_D - advHS_D);

  float T1 = clamp(hT_T/hTop1 , 200.0, 360.0), S1 = clamp(hS_T/hTop1 , 5.0, 60.0);
  float Td1= clamp(hT_D/hDeep1, 200.0, 360.0), Sd1= clamp(hS_D/hDeep1, 5.0, 60.0);
  if(isnan(T1))  T1  = top0.x;   if(isnan(S1))  S1  = top0.w;
  if(isnan(Td1)) Td1 = deep0.x;  if(isnan(Sd1)) Sd1 = deep0.w;

  // ---- 2/4. MOMENTUM: inter-layer mechanical drag (equal and opposite) ------
  // A shear stress tau = rho0*Cd*|dv|-modulated*(v_top - v_deep) [N/m^2] acts on
  // the interface. Dividing by the respective column mass rho0*h gives the two
  // accelerations, so mass-weighted momentum h*v gains and losses cancel
  // exactly: this is friction, not diffusion, and it does not depend on the
  // density stratification at all.
  vec2  dv = vT0 - vD0;
  vec2  fDrag = uDragI*dv*(1.0 + 0.5*length(dv));   // linear + quadratic form
  fDrag *= (1.0-land);

  vec2 accT = -gradPT/RHO0 + uNuVel*lapVT - advVT + vT0*divU_T - fDrag/hTop0;
  vec2 accD = -gradPD/RHO0 + uNuVel*lapVD - advVD + vD0*divU_D + fDrag/hDeep0;

  // Coriolis as a real 3D cross product, then projected on the tangent plane
  vec3 c3T = -2.0*cross(vec3(0.0,uOmega,0.0), vT0.x*e1 + vT0.y*e2);
  vec3 c3D = -2.0*cross(vec3(0.0,uOmega,0.0), vD0.x*e1 + vD0.y*e2);
  accT += vec2(dot(c3T,e1), dot(c3T,e2));
  accD += vec2(dot(c3D,e1), dot(c3D,e2));

  vec2 vT1 = (vT0 + uDt*accT)/(1.0 + uDt*uFricTop);
  vec2 vD1 = (vD0 + uDt*accD)/(1.0 + uDt*uFricDeep);
  vT1 *= (1.0-land); vD1 *= (1.0-land);
  vT1 = clamp(vT1, vec2(-3.0), vec2(3.0));
  vD1 = clamp(vD1, vec2(-3.0), vec2(3.0));
  if(any(isnan(vT1))) vT1 = vec2(0.0);
  if(any(isnan(vD1))) vD1 = vec2(0.0);

  outTop  = vec4(T1 , vT1, S1);
  outDeep = vec4(Td1, vD1, Sd1);
  outEta  = vec4(eta1, 0.0, 0.0, 0.0);
}

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  if(cell >= uCount){ oTop = vec4(0.0); oDeep = vec4(0.0); oEta = vec4(0.0); return; }
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz), e1 = cb.xyz, e2 = cross(e1, n);
  stepOcean(cell, n, e1, e2, ca.w, cb.w, oTop, oDeep, oEta);
}`;

var AIR_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oLoA;
layout(location=1) out vec4 oLoB;
layout(location=2) out vec4 oHiA;
layout(location=3) out vec4 oHiB;

uniform sampler2D uLoA, uLoB, uHiA, uHiB;
uniform float uDt, uOmega, uNuVel, uNuT, uFricLo, uFricHi, uRhoLo, uRhoHi;

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
  vec3 v3 = v0.x*e1 + v0.y*e2;
  vec3 c3 = -2.0*cross(vec3(0.0,uOmega,0.0), v3);
  acc += vec2(dot(c3,e1), dot(c3,e2));

  float f = fric*(1.0 + 2.0*land);
  vec2 v1 = (v0 + uDt*acc)/(1.0 + uDt*f);
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
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz), e1 = cb.xyz, e2 = cross(e1, n);
  stepAir(cell, n, e1, e2, ca.w, cb.w, uLoA, uLoB, uFricLo, uRhoLo, oLoA, oLoB);
  stepAir(cell, n, e1, e2, ca.w, cb.w, uHiA, uHiB, uFricHi, uRhoHi, oHiA, oHiB);
}`;

function COUPLE_FS(mode) {
  var outs = mode === 'ocean'
    ? `layout(location=0) out vec4 oTop;\nlayout(location=1) out vec4 oDeep;\nlayout(location=2) out vec4 oEta;`
    : `layout(location=0) out vec4 oLoA;\nlayout(location=1) out vec4 oLoB;\nlayout(location=2) out vec4 oHiA;\nlayout(location=3) out vec4 oHiB;`;
  return SHADER_HEAD + SHADER_COMMON + OCEAN_LAYERS + `
${outs}

uniform sampler2D uTop, uDeep, uLoA, uLoB, uHiA, uHiB, uEta;
uniform float uDt, uTime;
uniform vec3  uSun;
uniform float uSolar, uDayNight, uSeasonDecl;
uniform float uKsurf, uEvap, uWindStress, uConv, uKrad, uLapse;
uniform float uThermo, uCloudK, uRainK, uNoise, uGreenhouse;
uniform float uMassFix;

const float Le   = 2.5e6;
const float cpA  = 1004.0;
const float CwOc = 1.05e8;
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
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  float land = cb.w;
  float lat = asin(clamp(n.y,-1.0,1.0));

  vec4 wt = texelFetch(uTop , cTex(cell), 0);
  vec4 wd = texelFetch(uDeep, cTex(cell), 0);
  vec4 la = texelFetch(uLoA , cTex(cell), 0);
  vec4 lb = texelFetch(uLoB , cTex(cell), 0);
  vec4 ha = texelFetch(uHiA , cTex(cell), 0);
  vec4 hb = texelFetch(uHiB , cTex(cell), 0);
  float eta0 = texelFetch(uEta, cTex(cell), 0).r;
  float hTop0 = hTopOf(eta0);

  float Ts = wt.x, St = wt.w;      float Td = wd.x, Sd = wd.w;
  vec2  vt = wt.yz,  vd = wd.yz;
  vec2  vl = la.xy,  vh = ha.xy;
  float Tl = la.z,   Th = ha.z;
  float q  = lb.x,   qh = hb.x;
  float cloud = lb.y, rain = hb.y;

  float mu = mix(meanInsol(lat, uSeasonDecl), max(0.0, dot(n, uSun)), uDayNight);
  float alb = mix(0.08, 0.28, land) + 0.35*clamp(cloud,0.0,1.0);
  alb += 0.5*smoothstep(273.0, 258.0, Ts);
  float S = uSolar*mu*(1.0 - clamp(alb,0.0,0.9));

  float Cw = mix(CwOc*(hTop0/H_TOP0), CwLd, land);   // heat capacity follows the live layer thickness
  float spd = length(vl);
  float qs_s = qsat(Ts, 101325.0);
  float evap = (1.0 - 0.75*land)*uEvap*(0.6 + 0.08*spd)*max(0.0, qs_s - q);
  float Fsens = uKsurf*(Ts - Tl);
  float Fsol_s = S*0.76;

  Ts += uDt*(Fsol_s - Fsens - Le*evap)/Cw;
  Tl += uDt*(Fsens + 0.10*S)/Ca;
  q  += uDt*evap/(rhoL*Hlo);

${mode === 'ocean'
    ? `  // ---- MASS: the free surface also responds to precipitation minus evaporation
  // (the only true source/sink of ocean volume; the transport part of the
  // continuity equation is integrated in OCEAN_FS).
  float eta1 = eta0 + uDt*(rain*0.001 - evap)/RHO0*(1.0-land);
  eta1 -= uMassFix*eta1*uDt;                  // weak global mass-drift damper
  eta1 = clamp(eta1, -ETA_MAX, ETA_MAX);
  eta1 = mix(eta1, 0.0, land);
  if(isnan(eta1)) eta1 = 0.0;
  float hTop1 = hTopOf(eta1), hDeep1 = hDeepOf(eta1);

  // Salt is neither created nor destroyed by E-P: evaporation removes water and
  // leaves the salt behind, so the concentration simply follows the thickness.
  St *= hTop0/hTop1;`
    : `  // The air pass never writes the ocean state, so it only needs the CURRENT
  // layer thicknesses (for the mass-weighted wind stress below), not a new
  // free surface.
  float hTop1 = hTop0, hDeep1 = hDeepOf(eta0);`}

  // Wind stress: Newton's 3rd law, mass-weighted. The ocean top layer (~200 m
  // of water) has far more inertia per m^2 than the low-air column (~5000 m of
  // thin air): massRatio = (rhoL*Hlo)/(rho_w*H_top) ~= 1/37, so the SAME
  // momentum flux barely nudges the ocean but strongly decelerates the wind.
  // (Previously this was backwards: the ocean got the full impulse and the air
  // lost only 2%, which pumped spurious kinetic energy into the ocean and let
  // wind-driven currents overpower the thermohaline signal.)
  vec2 rel = vl - vt;
  vec2 dstress = uWindStress*uDt*rel*(1.0-land);
  float massRatio = (rhoL*Hlo)/(RHO0*hTop1);
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

  float rt = -0.00017*(Ts-283.0) + 0.00078*(St-35.0);
  float rd = -0.00017*(Td-283.0) + 0.00078*(Sd-35.0);
  // Mixing rate: a background rate everywhere plus enhancement from *either*
  // sign of instability (abs, not max(0,..)) -- unstable stratification can
  // arise either from surface cooling/salting (classic polar sinking) or from
  // the deep layer locally out-densifying the surface, and both should stir the
  // column, letting warm regions upwell instead of only ever sinking.
  float mix_ = clamp((uThermo*(1.0 + 900.0*abs(rt-rd)))*uDt, 0.0, 0.25);
  // Mass-(thickness-)weighted exchange, using the LIVE layer thicknesses so the
  // split adapts as the interface moves. The pair (wTopEx, wDeepEx) is what
  // makes the exchange conservative: h_top*dT_top + h_deep*dT_deep = 0, i.e.
  // the heat (and salt, and momentum) one layer loses the other gains exactly.
  float wTopEx  = hDeep1/(hTop1 + hDeep1);   // -> 0.8 at the reference 200/800
  float wDeepEx = hTop1 /(hTop1 + hDeep1);   // -> 0.2
  float dT = mix_*(Td - Ts), dS = mix_*(Sd - St);
  Ts += dT*wTopEx;   Td -= dT*wDeepEx;
  St += dS*wTopEx;   Sd -= dS*wDeepEx;
  vec2 dvm = 0.12*mix_*(vt - vd);
  vt -= dvm*wTopEx;  vd += dvm*wDeepEx;

  float nz = hash21(vec2(float(cell), floor(uTime*0.37)))-0.5;
  Tl += uNoise*nz;

  float Pl = 101325.0 - 60.0*(Tl - 288.0) + 25.0*(Th - 250.0);
  float Ph = 45000.0  + 75.0*(0.5*(Tl + Th) - 268.0);

  Ts = clamp(Ts, 200.0, 360.0);  Td = clamp(Td, 200.0, 360.0);
  Tl = clamp(Tl, 150.0, 360.0);  Th = clamp(Th, 150.0, 360.0);
  St = clamp(St, 5.0, 60.0);     Sd = clamp(Sd, 5.0, 60.0);
  q  = clamp(q , 0.0, 0.08);     qh = clamp(qh, 0.0, 0.08);
  vt *= (1.0-land);

${mode === 'ocean'
    ? `  oTop  = vec4(Ts, vt, St);
  oDeep = vec4(Td, vd, Sd);
  oEta  = vec4(eta1, 0.0, 0.0, 0.0);`
    : `  oLoA = vec4(vl, Tl, Pl);
  oLoB = vec4(q , cloud, 0.0, 0.0);
  oHiA = vec4(vh, Th, Ph);
  oHiB = vec4(qh, rain, 0.0, 0.0);`}
}`;
}

var INIT_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oTop;
layout(location=1) out vec4 oDeep;
layout(location=2) out vec4 oLoA;
layout(location=3) out vec4 oLoB;
uniform float uSeed;
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
  float Tl = 268.0 + 30.0*c2 + rn*1.2;
  float Th = 232.0 + 12.0*c2 + rn*0.6;
  float S  = 34.7 + 1.2*cos(2.0*lat) + rn*0.2;
  oTop  = vec4(Ts, 0.0, 0.0, S);
  oDeep = vec4(Td, 0.0, 0.0, S+0.3);
  oLoA  = vec4(rn*0.5, rn*0.5, Tl, 101325.0);
  oLoB  = vec4(0.004*c2, 0.0, 0.0, 0.0);
}`;

var INIT2_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oHiA;
layout(location=1) out vec4 oHiB;
// eta is initialised here rather than in INIT_FS purely to keep every
// framebuffer at <= 4 colour attachments (the WebGL2 guaranteed minimum).
layout(location=2) out vec4 oEta;
uniform float uSeed;
void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  float lat = asin(clamp(n.y,-1.0,1.0));
  float c2 = cos(lat)*cos(lat);
  float rn = hash21(vec2(float(cell), uSeed+7.0))-0.5;
  oHiA = vec4(rn*0.5, rn*0.5, 232.0 + 12.0*c2 + rn*0.6, 45000.0);
  oHiB = vec4(0.0008*c2, 0.0, 0.0, 0.0);
  oEta = vec4(0.0, 0.0, 0.0, 0.0);   // start from a flat, undisturbed sea surface
}`;

var PART_FS = SHADER_HEAD + SHADER_COMMON + `
out vec4 oPart;
uniform sampler2D uPart, uLookup, uLoA, uTop, uHiA, uDeep;
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
  else if(uVelMode==1) vel = texelFetch(uTop, cTex(cell),0).yz*uVelScale;
  else if(uVelMode==2) vel = texelFetch(uHiA, cTex(cell),0).xy;
  else                 vel = texelFetch(uDeep, cTex(cell),0).yz*uVelScale;
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
uniform sampler2D uPart, uLoA, uTop, uHiA, uDeep, uLookup;
uniform mat4 uMVP;
uniform ivec2 uPDim;
uniform float uTrail, uRadius, uEquirect, uVelScale, uAsPoints, uPointSize;
uniform int uVelMode;
out float vA;
void main(){
  int pid, seg, isTail;
  if (uAsPoints > 0.5) {
    pid = gl_VertexID; seg = 0; isTail = 0;
  } else {
    int vid = gl_VertexID;
    pid = vid / 6;
    int k = vid - pid*6;          // vid % 6  (0..5)
    seg = k / 2;                  // 0,1,2 -> centre / +1 / -1 wrap copy
    isTail = k - seg*2;           // 0 or 1
  }
  ivec2 t = ivec2(pid % uPDim.x, pid / uPDim.x);
  vec4 p = texelFetch(uPart, t, 0);
  vec3 pos = normalize(p.xyz);
  float lon = atan(pos.z, pos.x), lat = asin(clamp(pos.y,-1.0,1.0));
  int cell = int(texture(uLookup, vec2(lon/6.2831853+0.5, lat/3.14159265+0.5)).r + 0.5);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 e1 = cb.xyz, e2 = cross(e1, pos);
  vec2 vel;
  if(uVelMode==0)      vel = texelFetch(uLoA, cTex(cell),0).xy;
  else if(uVelMode==1) vel = texelFetch(uTop, cTex(cell),0).yz*uVelScale;
  else if(uVelMode==2) vel = texelFetch(uHiA, cTex(cell),0).xy;
  else                 vel = texelFetch(uDeep, cTex(cell),0).yz*uVelScale;
  vec3 v3 = vel.x*e1 + vel.y*e2;                              // tangent velocity (m/s)
  // Cap the angular extent of the streak so a very fast flow combined with a
  // long trail cannot paint a pathological line (near the limb in globe view,
  // or crossing the whole map in projection view).  Clamp the scalar arc length
  // directly, then back-step along the (unit) flow direction -- this keeps the
  // streak local to the head so the tail can never wrap past the date line.
  float s = length(v3) * (uTrail / uRadius);
  s = min(s, 0.5);                                            // ~30 deg cap
  vec3 tdir = (length(v3) > 1e-6) ? v3 / length(v3) : vec3(0.0);
  vec3 tail = normalize(pos - tdir * s);                      // arc back along flow
  vA = clamp(p.w,0.0,1.0) * clamp(1.5 - abs(p.w-0.5)*2.0, 0.0, 1.0);
  if(uEquirect > 0.5){
    // Unwrap the tail's longitude into the head's 2*PI period (so a streak
    // straddling the +/-PI seam stays continuous instead of drawing a line
    // across the whole map). Then draw THREE copies: the centre streak plus one
    // shifted by +/-1 in uv.x, so the part that runs off one edge of the map
    // re-appears on the opposite edge (seam-continuous streamlines).
    float hlon = lon;
    float tlon = atan(tail.z, tail.x);
    float dl = tlon - hlon;
    dl -= 6.2831853 * floor(dl/6.2831853 + 0.5);              // wrap delta to [-PI, PI]
    tlon = hlon + dl;
    vec2 huv = vec2(hlon/6.2831853+0.5, lat/3.14159265+0.5);
    vec2 tuv = vec2(tlon/6.2831853+0.5, asin(clamp(tail.y,-1.0,1.0))/3.14159265+0.5);
    float shift = (seg == 1) ? 1.0 : (seg == 2) ? -1.0 : 0.0;
    vec2 uv = (isTail == 1 ? tuv : huv) + vec2(shift, 0.0);
    gl_Position = vec4(uv*2.0 - 1.0, 0.0, 1.0);
  } else {
    // Globe view: only the centre copy is valid; push the +/-1 wrap copies
    // fully off-screen so they are culled (no 3x overdraw / brightness).
    vec3 outp = isTail == 1 ? tail : pos;
    if (seg == 0) gl_Position = uMVP * vec4(outp*1.012, 1.0);
    else gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
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
uniform sampler2D uTop, uDeep, uLoA, uLoB, uHiA, uHiB, uEta;
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
