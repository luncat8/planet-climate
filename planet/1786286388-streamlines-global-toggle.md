# Streamlines: global toggle + velocity-aligned line streaks

## Goal
1. Add a **global master checkbox** ("Streamlines", param `showParticles`) that gates all
   per-layer streamline rendering on/off. The per-layer checkboxes in the layer table remain the
   layer/source selectors (R/G/B/W = high/low/ocean/deep).
2. Improve the look + speed of the streamlines: render them as **line streaks** (thin line segments
   aligned to the local flow) instead of round point sprites.

## Why streaks (and why this technique)
The previous implementation rendered `gl.POINTS` dots — visible but not "flowing". The user's
suggested approach (store previous position, draw a line current→old) works but (a) needs an extra
`prevPos` texture/FBO and (b) yields only a single tiny step of displacement. **Recommended
technique:** draw each particle as a 2-vertex `gl.LINES` segment whose tail is computed from the
**instantaneous flow velocity** at the particle's cell, projected backward by a tunable trail
length. This is *faster* (no extra texture/FBO, one draw call, same cost as points) and *better
looking* (consistent, controllable-length streaks that always point along the flow; wind streaks
come out long, slow ocean/deep streaks short — physically correct). The advection step is unchanged,
so the recent movement fix stays valid.

## Files touched
- `shader.js` — rewrite `PART_VS` (line VS) + simplify `PART_PS` (line FS). `PART_FS` unchanged.
- `engine.js` — draw `gl.LINES` (2 verts/particle), pass new uniforms; gate both loops with `showParticles`.
- `params.js` — add `showParticles` (default true) + `streamTrail` (default 6000); remove unused `pointSize`.
- `app.js` — add `showParticles` to `chkDefs` (auto-wired like other booleans).

## shader.js
### PART_VS (rewrite as line vertex shader)
Inputs: `uPart, uLoA, uTop, uHiA, uDeep, uLookup`; `uMVP`; `uPDim`; `uTrail, uRadius, uEquirect`;
`uVelMode, uVelScale`. Outputs: `vA`.
```glsl
void main(){
  int pid = gl_VertexID >> 1;       // particle index (2 verts each)
  int isTail = gl_VertexID & 1;
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
  vec3 v3 = vel.x*e1 + vel.y*e2;                 // tangent velocity (m/s)
  vec3 tail = normalize(pos - v3 * (uTrail / uRadius));  // arc-length back along flow
  vec3 outp = isTail == 1 ? tail : pos;
  vA = clamp(p.w,0.0,1.0) * clamp(1.5 - abs(p.w-0.5)*2.0, 0.0, 1.0);
  if(uEquirect > 0.5){
    vec2 uv = vec2(atan(outp.z,outp.x)/6.2831853+0.5, asin(clamp(outp.y,-1.0,1.0))/3.14159265+0.5);
    gl_Position = vec4(uv*2.0-1.0, 0.0, 1.0);
  } else {
    gl_Position = uMVP * vec4(outp*1.012, 1.0);
  }
}
```

### PART_PS (simplify — no point sprite)
```glsl
in float vA; uniform vec3 uColor; out vec4 o;
void main(){ o = vec4(uColor, vA*0.75); }
```
(Remove `gl_PointCoord` / speed→color logic; `uColor` already supplied per set.)

## engine.js
### renderGlobe streamlines block (~line 444) and renderEquirect (~line 500)
Wrap the existing `for (pi…)` loop in `if (P.showParticles) { … }`. Inside, replace the draw setup:
```js
var pp = this.prog.points.use();
this.gridUniforms(pp);
pp.tex('uPart', ps.tex[ps.idx]).tex('uLookup', this.texLookup)
  .tex('uLoA', this.A[2]).tex('uTop', this.A[0]).tex('uHiA', this.A[4]).tex('uDeep', this.A[1])
  .iv2('uPDim', this.PW, this.PH).m4('uMVP', mvp).f('uEquirect', 0.0 /* or 1.0 equi */)
  .f('uTrail', P.streamTrail).f('uRadius', PLANET_R)
  .i('uVelMode', ps.velMode).f('uVelScale', ps.velScale)
  .v3('uColor', ps.color[0], ps.color[1], ps.color[2]);
gl.bindVertexArray(this.vaoEmpty);
gl.drawArrays(gl.LINES, 0, this.PW * this.PH * 2);
```
(Drop `uPointSize`.) `PLANET_R` is a global (geodesics.js); `mvp`/`dpr` already in scope.

### No change needed
`PART_FS` (advection) and `stepParticles()` are unchanged — particles still advect; the streak is
derived from instantaneous velocity, so the earlier "no movement" fix still applies.

## params.js
- Add non-tunable `showParticles: { default: true },`.
- Add tunable `streamTrail: { label: 'Streak length', default: 6000, min: 0, max: 30000, step: 500,
  fmt: function(v){ return (v/60).toFixed(0)+' min'; } }` — interpret as seconds of travel; longer =
  longer streaks. (Wind ~30 m/s → 6000 s ≈ 180 km streak; ocean/deep much shorter — expected.)
- Remove `pointSize` (now unused).

## app.js
- Add `['showParticles', 'Streamlines']` to `chkDefs` (near the other booleans). `ui.checks` +
  `refreshDynamic` already handle booleans generically, so no other change.

## Validation
- `node --check engine.js shader.js app.js params.js`.
- Browser: the "Streamlines" master checkbox hides/shows all streaks; per-layer checkboxes still
  select which R/G/B/W layers render; equirect toggle keeps streaks; selecting a coloring radio does
  not affect streamlines. Streaks are aligned to flow and move with the simulation. `streamTrail`
  slider changes streak length. Console clean.
- NOTE: WebGL core `gl.lineWidth` is effectively 1px, so streaks are thin lines (acceptable). If
  thicker ribbons are wanted later, that's a separate enhancement (per-particle quad/ribbon), out of
  scope here.

## Risks / notes
- `streamTrail` default (6000 s) and range are first approximations — tune for pleasing density.
- Deep-ocean (white) streaks may still be near-invisible due to slow `velScale` (60); if so, raise
  `velScale` for that layer in `build()` (already flagged in the prior plan).
- Removing `pointSize` param is safe (only used by the old point render).
