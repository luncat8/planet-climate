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

## Vertical mass-flux (up/down) field + view

Because the fluid is ~incompressible, horizontal convergence must be balanced by
vertical transport. The right diagnostic is **vertical MASS flux**, not vertical
velocity: velocity is not conserved across the density jump between layers (the
solver's layer speeds are not proportional to mass), but mass is — what sinks
out of one layer enters the other. `VFLOW_FS` computes it once per frame as
`rho * div(horizontal transport)`:

```
ocean:  m = rho_water * div(h_top · u_top)          rho_water = 1027
air:    m = -(rho_lo·Hlo) * div(u_low)              rho_lo·Hlo = 1.1·5000 = 5500
        (+ = upwelling / rising ; kg/m^2/s)
```

A single **"↕" view** per fluid (on the **Ocean** and **Low air** rows) shows it
with a diverging palette: **red = mass upwelling, blue = mass moving down**. The
deep/high layers are just the exact inverse of the same field, so their separate
maps were redundant and removed. The divergence-based recycling reads this same
mass-flux field, so viz and recycling never disagree.

### Mass in == mass out, by design (verified)

The integral of a divergence over a closed layer is zero, so **total upwelling
mass equals total downwelling mass by construction**. Measured on the bundled
equilibrium (L5, area-weighted over wet cells):

```
ocean:  up = +1.532e11 kg/s,  down = -1.532e11 kg/s,  imbalance = 1e-5 (0.001%)
air:    up = +5.88e12  kg/s,  down = -5.88e12  kg/s,  imbalance ~ 0
```

Per column the two layers carry the exact-inverse mass flux, so what leaves one
enters the other identically.

### The deep-flow suspicion (a real finding, left as physics)

`VFLOW_FS` also outputs the deep layer's own transport divergence (`.z`, mass
units) as a diagnostic. Its correlation with the top layer's is ≈ **-0.03** (not
-1), i.e. the deep dynamics do **not** independently return the top-layer
transport — nothing in the current solver enforces barotropic (column)
non-divergence; the free surface `eta` + steric / mass-spring terms absorb it.
The map/recycling sidestep this by defining the interface mass flux from the
single well-posed quantity and sharing it inverted, which is mass-consistent by
construction. Making the *dynamics themselves* column-non-divergent (a rigid-lid
constraint) is a larger physics change that risks the tuned equilibrium and is
intentionally not done here.

## Buffers / cost

Per layer: `state` A/B (`PW×PH`, head+phase) and `trail` A/B (`PW×PH·PT`).
`PW=PH=128`, `PT=40` ⇒ ~84 MB of float textures across the 4 layers. Passes per
frame: 1 `VFLOW`, 4×(`SMOOTH`,`STATE`,`TRAIL`). Physics is untouched.

## Verified

- `node harness/render.js --dir=planet --level=5` → 20 programs compiled, 36
  mode/projection draws (incl. the 4 new up/down modes), 0 failures / 0 errors.
- Runtime loop across all method combinations: no GL errors; `vflow`, `state`
  and `trail` textures all finite (NaN-free) for every layer.
