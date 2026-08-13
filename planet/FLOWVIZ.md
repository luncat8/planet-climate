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

**Mass-consistent recycling** (`flowRecycle`, *superseded by the Round-3 pool
model below*): originally, instead of dying at random, a
particle ages faster where the flow *converges* (it is being carried down out of
its layer) and is reborn where the flow *diverges* (upwelling, sampled by
rejection). Deaths-at-sinks balanced by births-at-sources holds the particle
density ≈ uniform — i.e. it honours incompressibility — and makes particles
trace the overturning circulation. Off ⇒ plain long life + uniform random
rebirth.

## Round 3 — particle POOLS with inter-layer overturning

Round 2's four independent per-layer particle systems (top ocean, deep ocean,
low air, high air) each recycled *within* their own layer. That reads as flat 2-D
flow and, worse, the deep/high systems were driven by near-motionless fields, so
they looked like static noise. The redesign collapses each fluid's two sublayers
into **one shared pool** whose members migrate vertically, so a single particle
traces the full overturning cell.

**Two pools, not four systems.** `buildGrid` builds `this.pools = [ocean, air]`.
Each pool owns one `state`/`trail` ping-pong pair and a `cfg` describing its two
sublayers:

| pool | sublayers (sub0 / sub1) | `col` (sub0→sub1) | `idx` (streamline bits) | `wChan` | `fluxSign` |
|---|---|---|---|---|---|
| ocean | surface / deep | blue → white | 2 (ocean) / 3 (deep) | 0 | −1 |
| air | low / high | green → red | 1 (low air) / 0 (high air) | 1 | +1 |

**Layer packed into the particle.** A pool particle's state is `vec4(pos, w)`
where `w = layer + age`: `layer = floor(w+0.5) ∈ {0,1}` is which sublayer it is
currently in, and `age = frac(w) ∈ [0, 0.9999]` is its life phase (capped so the
floor stays exact). `bindFlow(pool)` binds *both* sublayers' velocity /
smoothed-velocity textures (`uVel0/uVel1`, `uSmooth0/uSmooth1`) and `STATE_FS`
advects on whichever the particle's `layer` selects.

**Vertical transitions ∝ mass flux.** Each frame `STATE_FS` reads the pool's
vertical mass-flux field (channel `uWChan` of `VFLOW`, signed by `uFluxSign` so
that "leaving my current sublayer" is always the positive test) at the
particle's cell. The transition probability that frame is
`p = clamp(uTransK · |flux| · uVScale, 0, uMaxP)` with `uTransK = 2·flowMix`,
`uMaxP = 0.25` — so a particle over strong downwelling flips surface→deep quickly,
one over quiet water rarely moves, and total up-transitions balance
down-transitions because the flux field integrates to zero (see below). Migration
only fires in the correct direction for the local flux sign, so particles descend
where mass sinks and rise where it wells up.

**Lifespan.** `age` advances `+uLife` per frame (`uLife` from **Lifetime
(days)**); at `age≥1` the particle despawns and respawns at a fresh cell with a
random sublayer, keeping the pool's population ≈ constant.

**Trails show the overturning.** `TRAIL_FS` stores each slot's `layer` alongside
its position; `PART_VS` colours each slot by its slot-layer via `uColor0/uColor1`
and gates it against the enabled streamline bits (`uMask`, `uIdx0/uIdx1`). So a
trail that crossed between sublayers is drawn with a **colour transition along its
length** (blue→white as water sinks, green→red as air rises), and a sublayer the
user has toggled off simply drops its coloured segments. A pool is skipped
entirely when neither of its bits is enabled.

Controls unchanged except **Move between layers** (`flowRecycle`, the master
on/off for migration + flux-driven aging) and the new **Mix rate** (`flowMix`,
0–3×, scales `uTransK` — how eagerly particles overturn).

**Particle count** (`flowParticles`, 2–64 k per pool) sizes the `PW×PH` particle
grid. Because it's a rarely-touched setting, changing it does a one-time pool
rebuild (`rebuildPools` — new `state`/`trail` textures, physics grid and
equilibrium untouched) rather than resizing live; this keeps the steady-state
update/draw path fast at the cost of a brief rebuild on change. The side is
clamped to the GPU's `MAX_TEXTURE_SIZE` (the trail texture is `PW × PH·PT`), so
huge counts degrade gracefully instead of erroring.

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

Per **pool** (2 total): `state` A/B (`PW×PH`, head+packed layer/age) and `trail`
A/B (`PW×PH·PT`, position+slot-layer). `PW=PH` derives from the **Particle count**
slider (default 16 k ⇒ 126², clamped to `MAX_TEXTURE_SIZE`); `PT=40`. Shared, built once: 4 smoothed-velocity EMA
textures (one per sublayer source) and the `VFLOW` mass-flux field. Passes per
frame: 1 `VFLOW`, 4 `SMOOTH`, 2×(`STATE`,`TRAIL`). Physics is untouched.

## Verified

- `node harness/render.js --dir=planet --level=5` → 24 programs compiled, 36
  mode/projection draws, 0 failures / 0 consoleErrors.
- Runtime pool loop (`harness/pool.js`): both pools finite (0 NaN in `state` and
  `trail`), all `age∈[0,1)`, and members actually migrate — after 30 steps the
  ocean pool sits ≈27% surface / 73% deep and the air pool ≈23% low / 77% high
  (started 50/50), confirming flux-driven inter-layer transitions fire. Both
  projections render without GL error.
- Overturning trails captured: `docs/v3b_ocean_overturn.png` (blue↔white),
  `docs/v3b_air_overturn.png` (green↔red).

