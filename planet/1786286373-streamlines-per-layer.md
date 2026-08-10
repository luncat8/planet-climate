# Streamlines as a per-layer table column

## Goal
Move streamline control into the layer/view table: add a per-layer **Streamlines** checkbox column
placed immediately after the **Speed** column. Up to 4 streamlines (one per physical layer) can be
enabled at once; each is advected by that layer's own velocity field and drawn in a fixed layer
color — R / G / B / W for high air / low air / ocean / deep ocean. Streamlines are **independent**
of the single layer/view radio used for surface coloring (e.g. Temperature radio + ocean lines on).
Replace the old `showParticles` / `particleOcean` params with a single `streamline` bitmask
(int, default `2` = low-air on, preserving the previous look).

## Files touched
- `shader.js` — `PART_FS`, `PART_VS`, `PART_PS` (multi-source advection + per-layer color).
- `engine.js` — `Planet` ctor, `build()`, `destroyGrid()`, `stepParticles()`, `renderGlobe` / `renderEquirect` streamline blocks.
- `params.js` — drop `showParticles`/`particleOcean`, add `streamline`.
- `app.js` — drop the 2 `chkDefs` entries, add the stream column + `ui.streamlineChecks`, update `refreshDynamic`.
- `index.html` — CSS for the new column.

## Data model
`LAYER_VIEW` order (top→bottom): `[highAir(0), lowAir(1), ocean(2), deepOcean(3)]`. Per-layer
velocity source + render color (define once in `engine.js build()` as the `layers` array below):

| layer | velocity source | velMode | velScale | color |
|---|---|---|---|---|
| highAir(0) | `uHiA.xy` (ha.xy) | 2 | 1 | R `(1,0,0)` |
| lowAir(1)  | `uLoA.xy` (la.xy) | 0 | 1 | G `(0,1,0)` |
| ocean(2)   | `uTop.yz` (wt.yz) | 1 | 6 | B `(0,0,1)` |
| deepOcean(3)| `uDeep.yz` (vd)   | 3 | 60 (tune) | W `(1,1,1)` |

`params.streamline` = int bitmask, bit `i` = layer `i` enabled. Default `2` (low-air on).

## shader.js
### PART_FS (line 478)
- Declarations: add `uniform sampler2D uHiA, uDeep;`, replace `... uOcean;` with
  `uniform int uVelMode; uniform float uVelScale;`.
- Replace
  `vec2 uvw = mix(texelFetch(uLoA,cTex(cell),0).xy, texelFetch(uTop,cTex(cell),0).yz*6.0, uOcean);`
  with:
  ```glsl
  vec2 vel;
  if(uVelMode==0)      vel = texelFetch(uLoA, cTex(cell),0).xy;
  else if(uVelMode==1) vel = texelFetch(uTop, cTex(cell),0).yz*uVelScale;
  else if(uVelMode==2) vel = texelFetch(uHiA, cTex(cell),0).xy;
  else                 vel = texelFetch(uDeep, cTex(cell),0).yz*uVelScale;
  vec2 uvw = vel;
  ```
  Keep `v3 = uvw.x*e1 + uvw.y*e2;` and the rest unchanged.

### PART_VS (line 520)
- Drop velocity entirely: remove `uLoA, uTop, uOcean`, the `vSpd` out, and the `uvw` sample.
  Keep `uPart, uLookup, uMVP, uPDim, uPointSize, uEquirect`; compute position + `vA` only.

### PART_PS (line 546)
- Add `uniform vec3 uColor;`. Replace the speed→color mix with a flat layer color:
  `vec3 c = uColor;` and `o = vec4(c, m*vA*0.75);`. Remove `vSpd` in/out.

## engine.js
### ctor (line 113)
- Replace `this.partTex = []; this.partIdx = 0;` with `this.part = [];`.

### build() (lines 237–239)
- After `pdata` is built (line 231), create 4 ping-pong sets instead of one:
  ```js
  var self = this;
  var streamLayers = [
    { velMode:2, velScale:1,  color:[1,0,0] },
    { velMode:0, velScale:1,  color:[0,1,0] },
    { velMode:1, velScale:6,  color:[0,0,1] },
    { velMode:3, velScale:60, color:[1,1,1] },
  ];
  this.part = streamLayers.map(function (L) {
    var a = self.mkTex(self.PW, self.PH, pdata), b = self.mkTex(self.PW, self.PH, pdata);
    return { tex:[a,b], idx:0, fb:{ a:self.mkFbo([a]), b:self.mkFbo([b]) },
             velMode:L.velMode, velScale:L.velScale, color:L.color };
  });
  ```

### destroyGrid() (lines 254, 261)
- Flatten set textures for cleanup: `var partTexs = this.part.reduce(function(a,s){return a.concat(s.tex);},[]);`
  and use `this.A.concat(this.B, partTexs, [texCellA,...])`. Reset `this.part = []`.

### stepParticles(dt) (lines 352–366)
- Loop over `this.part`; for each set `s`: advect `uPart=s.tex[s.idx]` → dst `s.fb.a/s.fb.b`,
  set `uHiA=this.A[4]`, `uDeep=this.A[1]`, `uLoA=this.A[2]`, `uTop=this.A[0]`,
  `uVelMode=s.velMode`, `uVelScale=s.velScale`. Ping-pong `s.idx = 1 - s.idx`.
  Reuse the single `prog.part`. (Stepping all 4 every frame is cheap: 4×25600 invocations.)

### renderGlobe streamlines (lines 430–447) & renderEquirect (lines 485–495)
- Replace the `if (P.showParticles){...}` block with a blend-once loop:
  ```js
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.depthMask(false); gl.disable(gl.CULL_FACE);
  for (var i = 0; i < this.part.length; i++) {
    if (((P.streamline >> i) & 1) === 0) continue;
    var s = this.part[i];
    var pp = this.prog.points.use(); this.gridUniforms(pp);
    pp.tex('uPart', s.tex[s.idx]).tex('uLookup', this.texLookup)
      .iv2('uPDim', this.PW, this.PH).m4('uMVP', mvp)
      .f('uEquirect', <0.0 globe / 1.0 equi>)
      .f('uPointSize', P.pointSize * Math.min(2, dpr))
      .v3('uColor', s.color[0], s.color[1], s.color[2]);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(gl.POINTS, 0, this.PW * this.PH);
  }
  gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
  ```

## params.js
- Remove `showParticles` and `particleOcean` (lines 37–38). Add `streamline: { default: 2 },`
  in the non-tunable block. (Generic preset/JSON export already handles int keys.)

## app.js
- Remove the `['showParticles', ...]` and `['particleOcean', ...]` entries from `chkDefs` (lines 253–254).
- Add `ui.streamlineChecks = {};` (near `layerRadios`).
- buildUI table: after the per-view `<td>` loop, append a **stream `<td>`** per layer row containing
  a checkbox keyed by layer index; also append one `<th class="stream">` (glyph "≋", `title="Streamlines"`)
  after the view `<th>`s.
  - `onchange`: `setParam('streamline', setStreamBit(ui.planet.params.streamline, layerIndex, this.checked));`
    with `function setStreamBit(mask,i,on){ return on ? (mask|(1<<i)) : (mask & ~(1<<i)); }`
  - Add a small color swatch (`.swatch`) in the stream `<td>` tinted to the layer's R/G/B/W so the
    user can map checkbox → line color. Store `ui.streamlineChecks[layerIndex] = inp`.
- `refreshDynamic`: after the `layerRadios` loop, add
  `Object.keys(ui.streamlineChecks).forEach(function(i){ ui.streamlineChecks[i].checked = ((P.streamline>>i)&1)!==0; });`

## index.html CSS
- `.ltable th.stream, .ltable td.stream { /* narrow stream column */ }`
- `.ltable td.stream input { accent-color:#22d3ee; }`
- `.ltable .swatch { display:inline-block; width:9px; height:9px; border-radius:50%; }`
  (background set inline per layer color).

## Validation
- `node --check engine.js shader.js app.js`.
- Browser: 4 streamline checkboxes appear right after the Speed column. Enabling each draws
  streamlines in R/G/B/W for high/low/ocean/deep, advected by that layer's velocity (high & low
  move like wind; ocean slower; deep ocean slow — tune scale). Disabling all hides lines.
  Selecting a coloring radio (e.g. Temperature) does NOT change which streamlines show.
  Equirect toggle keeps streamlines. Preset/JSON load restores `streamline` bitmask (no console errors).

## Risks / tuning
- `deepOcean` velScale `60` is a first guess (deep currents ~10–100× slower than surface) — tune so
  the W lines actually move. `lowAir=1`, `ocean=6` mirror existing behavior; `highAir=1` matches wind.
- Default `streamline=2` → low-air streamlines now render **green** instead of the old speed-blue;
  acceptable visual change, same layer shown by default.
- `uVelMode` stays a uniform in `PART_FS` (tiny 25600-frag pass) — not the per-pixel render hot path,
  so this is fine and far simpler than 4 compiled variants.
