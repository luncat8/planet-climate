# Flow visualization

Problem: the raw per-cell velocity is dominated by fast turbulent fluctuations,
while the coherent mean currents are slow — worst of all in the deep/bottom
layer. Advecting particles directly on that field produces slowly-shifting
*noise* rather than clean current lines.

The fix is a small toolbox of **combinable** rendering methods, exposed in the
UI ("Flow visualization" panel) as checkboxes + sliders. None of them touch the
physics — they only change how the streamline layer is advected and drawn. All
off reproduces the legacy behaviour.

## Methods

| Control | Param | What it does |
|---|---|---|
| **Time-averaged flow** | `flowAvg` | Advect on a running exponential moving average of the velocity field instead of the instantaneous field. Turbulent noise cancels over time; the coherent mean current survives, so stable streamlines emerge. |
| Averaging strength | `flowSmooth` (0–0.98) | EMA memory. `alpha = 1 - flowSmooth`; higher = smoother / longer memory. |
| **Continuous lines** | `flowLines` | Draw smooth multi-segment streamlines that integrate the (smoothed) field, instead of dots / a single short streak. This is "continuous lines instead of particles". |
| Line segments | `flowSegs` (2–48) | Vertices per streamline polyline. |
| **Even out speed** | `flowUniform` | Advect at a constant unit pace (direction only), so even the very slow bottom water animates and its lines have a legible length. |
| Flow gain | `flowGain` (0.2–8×) | Velocity multiplier. In uniform mode it doubles as line-length control. |

The per-layer enable checkboxes (High air / Low air / Ocean / Deep ocean) and
the **Streamline length** slider (`streamTrail`; 0 = dots) are unchanged and
compose with the above.

## Implementation

* `SMOOTH_FS` (shader.js) maintains one RG float texture per layer:
  `avg <- mix(avg, current, alpha)`, run once per layer per frame by
  `Planet.stepSmooth()`. NaN-robust (a garbage `prev` can't poison the average).
* `layerVel()` in `PART_VEL_GLSL` is the single place smoothing / normalization
  / gain are applied, shared by the advection pass (`PART_FS`) and the draw
  (`PART_VS`), so they always agree.
* `PART_VS` back-integrates the field `K = flowSegs` steps from each particle to
  build a curved streamline, drawn as `GL_LINES` (`2*K` verts/particle) that
  fades toward the tail. `K = 1` reproduces the old single back-step streak;
  `streamTrail = 0` still draws dots.

New params default to averaged continuous lines on. They round-trip through
save/load (`applyState` merges over `defaultParams()`) and view-preset capture
(`screenshot.js` `VIEW_KEYS`).

## Verified

`node harness/render.js --dir=planet --level=5` → 18 programs compiled, 36
mode/projection draws, 0 failures / 0 console errors. A runtime loop test across
all five method combinations (avg+lines, streaks, dots, raw lines, uniform)
showed no GL errors and finite (NaN-free) smoothed + particle textures.
