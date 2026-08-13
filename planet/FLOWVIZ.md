# Flow visualization

The velocity field is dominated by fast turbulent fluctuations while the coherent
currents are slow, so naive per-frame confetti advected on the raw field looks
like slowly-shifting noise — worst in the near-motionless deep/bottom layer.
Two rounds of work address this.

## Round 1 — de-noising toolbox (combinable, in the "Flow visualization" panel)

| Control | Param | Effect |
|---|---|---|
| **Time-averaged flow** | `flowAvg` / `flowSmooth` | Advect on a running EMA of the field (`SMOOTH_FS`); noise cancels, the mean current survives. |
| **Even out speed** | `flowUniform` | Advect at a constant unit pace (direction only) so slow layers still animate; length set by the trail budget + gain. |
| **Flow gain** | `flowGain` | Velocity multiplier to amplify slow layers. |

## Round 2 — persistent tracers, real trails, mass-consistent recycling

The old system killed/respawned particles at random and drew the "tail" as an
*instantaneously re-integrated streakline*. That flickered two ways: a rebirth
popped a full-length tail into existence, and a change of flow direction swung
the whole tail. It also ignored that water is (nearly) incompressible.

**Persistent particles + history trail.** Particles now live long and their tail
is the *real swept path*, stored as a conveyor of the last `PT` positions per
particle:

- `STATE_FS` advances only the head position + a life phase `age∈[0,1]`.
- `TRAIL_FS` shifts the history one slot per frame and writes the new head to
  slot 0 (double-buffered to avoid a feedback loop). A rebirth (head jumps far
  from last frame's head) collapses every slot onto the head, so the trail
  restarts as a zero-length point and *grows* — no tail pop.
- The draw (`PART_VS`) strokes slots `0..flowSegs` as a `GL_LINES` polyline with
  a smooth **fade-in on birth / fade-out near death** envelope — no flicker.
- Controls: **Continuous trails** (`flowLines`, off ⇒ dots), **Trail length**
  (`flowSegs`), **Lifetime (days)** (`flowLife`).

**Mass-consistent recycling** (`flowRecycle`): instead of dying at random, a
particle ages faster where the flow *converges* (it is being carried down out of
its layer) and is reborn where the flow *diverges* (upwelling, sampled by
rejection). Deaths-at-sinks balanced by births-at-sources holds the particle
density ≈ uniform — i.e. it honours incompressibility — and makes particles
trace the overturning circulation. Off ⇒ plain long life + uniform random
rebirth.

## Vertical flow (up/down) field + view

Because the fluid is ~incompressible, horizontal convergence must be balanced by
vertical motion. The interface vertical velocity is one well-defined quantity per
column, computed once per frame by `VFLOW_FS` (one FV divergence pass):

```
w_ocean = div(h_top · u_top)      (+ = upwelling, deep water rising into the top)
w_air   = -div(u_low)             (+ = ascent from low-level convergence)
```

New **"↕" (up/down)** column in the layer/view table shows it with a diverging
palette (blue = sinking, warm = rising). The two ocean layers share it with
**opposite sign by construction** (`ocean = +w`, `deep = -w`); likewise low/high
air — exactly the "just inverted, up to a multiplier" relation requested. The
recycling above reads this same field, so viz and recycling never disagree.

### Verification of the "equal and opposite" question (a real finding)

`VFLOW_FS` also outputs `div(h_deep · u_deep)` (channel `.z`) purely as a
diagnostic. Measured on the bundled equilibrium (L5, wet ocean cells):

```
rms( div(h_top u_top) )                     = 1.08e-6
rms( div(h_top u_top) + div(h_deep u_deep)) = 2.06e-6   (ratio 1.92)
corr( div(h_top u_top), div(h_deep u_deep)) = -0.03
```

If the deep layer were the exact return flow of the top (rigid-lid, column
non-divergent) we would see `corr ≈ -1` and the sum `≈ 0`. Instead the two
layers' horizontal divergences are essentially **uncorrelated** — the deep
dynamics do *not* mass-balance the top. So the suspicion was correct: nothing in
the current solver enforces barotropic non-divergence (the free surface `eta` +
steric / mass-spring terms absorb it).

For visualization and recycling this is handled the correct way: the interface
vertical velocity is taken from the single well-posed quantity (top-layer
continuity) and shared **inverted** between the layers, so what leaves the top
enters the deep exactly — mass-consistent by construction. Making the *dynamics*
themselves column-non-divergent (a rigid-lid / barotropic-divergence constraint)
is a separate, larger physics change that risks the tuned equilibrium; it is
intentionally **not** done here. Flag if you want that pursued.

## Buffers / cost

Per layer: `state` A/B (`PW×PH`, head+phase) and `trail` A/B (`PW×PH·PT`).
`PW=PH=128`, `PT=40` ⇒ ~84 MB of float textures across the 4 layers. Passes per
frame: 1 `VFLOW`, 4×(`SMOOTH`,`STATE`,`TRAIL`). Physics is untouched.

## Verified

- `node harness/render.js --dir=planet --level=5` → 20 programs compiled, 36
  mode/projection draws (incl. the 4 new up/down modes), 0 failures / 0 errors.
- Runtime loop across all method combinations: no GL errors; `vflow`, `state`
  and `trail` textures all finite (NaN-free) for every layer.
