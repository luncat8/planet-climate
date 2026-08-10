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
];
// modes that use magnitude (dark-background) coloring; palette-color fields excluded
var MODE_MAG = { 3:1, 4:1, 5:1, 6:1, 11:1, 12:1, 13:1 };
function modeValueSrc(m) {
  return 'float v = ' + (MODE_FIELDS[m] != null ? MODE_FIELDS[m] : MODE_FIELDS[9]) + ';';
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
uniform sampler2D uTop, uDeep, uLoA, uLoB, uHiA, uHiB, uLookup;
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

var OCEAN_FS = SHADER_HEAD + SHADER_COMMON + `
layout(location=0) out vec4 oTop;
layout(location=1) out vec4 oDeep;

uniform sampler2D uTop;
uniform sampler2D uDeep;
uniform float uDt, uOmega, uNuVel, uNuT, uFricTop, uFricDeep, uAlphaT, uBetaS;
uniform float uPkTop, uPkDeep;

float oceanP(vec4 s, float pk){
  return pk*(uAlphaT*(s.x-283.0) - uBetaS*(s.w-35.0));
}

vec4 stepOcean(int cell, vec3 n, vec3 e1, vec3 e2, float area, float land,
               sampler2D tex, float fric, float pk, float vmax)
{
  vec4 s0 = texelFetch(tex, cTex(cell), 0);
  vec2 v0 = s0.yz;
  vec2 tr0 = vec2(s0.x, s0.w);
  float p0 = oceanP(s0, pk);

  vec2 gradP = vec2(0.0), lapV = vec2(0.0), advV = vec2(0.0);
  vec2 lapT  = vec2(0.0), advT = vec2(0.0);
  float div = 0.0;

  for(int k=0;k<6;k++){
    vec4 na = texelFetch(uNbrA, nTex(cell,k), 0);
    if(na.w < 0.5) continue;
    int   j = int(na.x);
    float L = na.y;
    float d = na.z;
    vec4  nb = texelFetch(uNbrB, nTex(cell,k), 0);
    vec2  nrm = nb.xy;

    vec4 sj    = texelFetch(tex,   cTex(j), 0);
    float landj= texelFetch(uCellB,cTex(j), 0).w;
    float wet  = (1.0-landj)*(1.0-land);

    vec2 vj  = xfer(sj.yz, nb.z, nb.w) * (1.0-landj);
    vec2 trj = vec2(sj.x, sj.w);
    float pj = oceanP(sj, pk);

    gradP += L*0.5*(pj-p0)*nrm*wet;
    lapV  += (L/d)*(vj-v0)*wet;
    lapT  += (L/d)*(trj-tr0);
    float un = 0.5*dot(v0+vj, nrm)*wet;
    div  += L*un;
    float w = un > 0.0 ? 0.0 : 1.0;
    advT += L*un*mix(tr0, trj, w);
    advV += L*un*mix(v0,  vj,  w);
  }

  float ia = 1.0/area;
  gradP *= ia; lapV *= ia; lapT *= ia; advV *= ia; advT *= ia; div *= ia;

  vec2 acc = -gradP/1027.0 + uNuVel*lapV - advV + v0*div;
  vec3 v3 = v0.x*e1 + v0.y*e2;
  vec3 c3 = -2.0*cross(vec3(0.0,uOmega,0.0), v3);
  acc += vec2(dot(c3,e1), dot(c3,e2));

  vec2 v1 = (v0 + uDt*acc)/(1.0 + uDt*fric);
  v1 *= (1.0-land);
  v1 = clamp(v1, vec2(-vmax), vec2(vmax));

  vec2 tr1 = tr0 + uDt*(uNuT*lapT - advT + tr0*div);
  tr1.x = clamp(tr1.x, 200.0, 360.0);
  tr1.y = clamp(tr1.y, 5.0, 60.0);
  if(any(isnan(v1))) v1 = vec2(0.0);
  if(any(isnan(tr1))) tr1 = tr0;
  return vec4(tr1.x, v1, tr1.y);
}

void main(){
  int cell = int(gl_FragCoord.x) + int(gl_FragCoord.y)*uDim.x;
  if(cell >= uCount){ oTop = vec4(0.0); oDeep = vec4(0.0); return; }
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz), e1 = cb.xyz, e2 = cross(e1, n);
  oTop  = stepOcean(cell, n, e1, e2, ca.w, cb.w, uTop,  uFricTop,  uPkTop,  2.5);
  oDeep = stepOcean(cell, n, e1, e2, ca.w, cb.w, uDeep, uFricDeep, uPkDeep, 1.2);
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
    ? `layout(location=0) out vec4 oTop;\nlayout(location=1) out vec4 oDeep;`
    : `layout(location=0) out vec4 oLoA;\nlayout(location=1) out vec4 oLoB;\nlayout(location=2) out vec4 oHiA;\nlayout(location=3) out vec4 oHiB;`;
  return SHADER_HEAD + SHADER_COMMON + `
${outs}

uniform sampler2D uTop, uDeep, uLoA, uLoB, uHiA, uHiB;
uniform float uDt, uTime;
uniform vec3  uSun;
uniform float uSolar, uDayNight, uSeasonDecl;
uniform float uKsurf, uEvap, uWindStress, uConv, uKrad, uLapse;
uniform float uThermo, uCloudK, uRainK, uNoise, uGreenhouse;
uniform float uContK, uHtop, uHdeep;

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

  float Cw = mix(CwOc, CwLd, land);
  float spd = length(vl);
  float qs_s = qsat(Ts, 101325.0);
  float evap = (1.0 - 0.75*land)*uEvap*(0.6 + 0.08*spd)*max(0.0, qs_s - q);
  float Fsens = uKsurf*(Ts - Tl);
  float Fsol_s = S*0.76;

  Ts += uDt*(Fsol_s - Fsens - Le*evap)/Cw;
  Tl += uDt*(Fsens + 0.10*S)/Ca;
  q  += uDt*evap/(rhoL*Hlo);
  St += uDt*(evap - rain*0.001)*35.0/(1027.0*40.0);

  // Mass-weighted wind stress: the same momentum impulse changes the much
  // lighter air column far more than it changes the ocean mixed layer.
  vec2 rel = vl - vt;
  vec2 dstress = uWindStress*uDt*rel*(1.0-land);
  vt += dstress*0.026;
  vl -= dstress;

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
  // Bidirectional vertical exchange. Dense surface water over lighter deep
  // water convects rapidly; the stable case (warm/light on top) still gets a
  // weaker, nonzero upwelling exchange instead of being switched off.
  float unstableSink = max(0.0, rt-rd);
  float stableUpwell = max(0.0, rd-rt);
  float mix_ = clamp((uThermo*(0.35 + 1000.0*unstableSink + 250.0*stableUpwell))*uDt, 0.0, 0.22);
  float dT = mix_*(Td - Ts), dS = mix_*(Sd - St);
  Ts += dT;   Td -= dT*0.22;
  St += dS;   Sd -= dS*0.22;
  vec2 dvm = 0.12*mix_*(vt - vd);
  vd += dvm; vt -= dvm*0.22;

  // Two-layer continuity closure. With no rigid-lid/Poisson solve the two
  // layers are otherwise free to transport mass in the same direction. Damp
  // the net column transport (uHtop*vt + uHdeep*vd -> 0) by nudging the deep
  // layer, so the deep limb returns flow instead of driving the cell itself.
  // Driven by uContK, NOT uThermo: continuity is a structural constraint and
  // must stay active regardless of the mixing diffusivity.
  // The clamp keeps the implicit self-damping factor (1 - overturn) positive.
  vec2 transport = uHtop*vt + uHdeep*vd;
  float overturn = clamp((0.10 + 650.0*unstableSink + 120.0*stableUpwell)*uContK*uDt, 0.0, 0.25);
  vd -= overturn*transport/uHdeep;

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
  oDeep = vec4(Td, vd, Sd);`
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
  else if(uVelMode==1) vel = texelFetch(uTop, cTex(cell),0).yz*uVelScale;
  else if(uVelMode==2) vel = texelFetch(uHiA, cTex(cell),0).xy;
  else                 vel = texelFetch(uDeep, cTex(cell),0).yz*uVelScale;
  vec3 v3 = vel.x*e1 + vel.y*e2;                              // tangent velocity (m/s)
  vec3 tail = normalize(pos - v3 * (uTrail / uRadius));       // arc back along flow
  vec3 outp = isTail == 1 ? tail : pos;
  vA = clamp(p.w,0.0,1.0) * clamp(1.5 - abs(p.w-0.5)*2.0, 0.0, 1.0);
  if(uEquirect > 0.5){
    vec2 uv = vec2(atan(outp.z,outp.x)/6.2831853+0.5, asin(clamp(outp.y,-1.0,1.0))/3.14159265+0.5);
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
uniform sampler2D uTop, uDeep, uLoA, uLoB, uHiA, uHiB;
uniform mat4 uMVP;
uniform float uRelief;
out vec3 vN; out float vVal; out float vLand; out float vCloud; out vec3 vPos;
void main(){
  int cell = gl_VertexID;
  vec4 ca = texelFetch(uCellA, cTex(cell), 0);
  vec4 cb = texelFetch(uCellB, cTex(cell), 0);
  vec3 n = normalize(ca.xyz);
  vec4 wt = texelFetch(uTop, cTex(cell),0);
  vec4 la = texelFetch(uLoA, cTex(cell),0);
  vec4 lb = texelFetch(uLoB, cTex(cell),0);
  vec4 ha = texelFetch(uHiA, cTex(cell),0);
  vec4 hb = texelFetch(uHiB, cTex(cell),0);
  vec4 wd = texelFetch(uDeep, cTex(cell),0);
${modeValueSrc(m)}
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
  vC = clamp(texelFetch(uLoB, cTex(cell),0).y, 0.0, 1.0);
  vR = clamp(texelFetch(uHiB, cTex(cell),0).y, 0.0, 2.0);
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
