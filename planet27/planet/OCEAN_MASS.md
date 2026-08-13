# Deep-ocean mass flow — investigation & refactor

## The complaint
The deep ocean layer "was always suspect of a bug." Diagnostic (bundled L5
equilibrium, area-weighted over wet cells) of the two layers' horizontal
transport divergence:

```
corr( div(h_top·u_top), div(h_deep·u_deep) ) = -0.03     (expected ≈ -1)
rms( div(h_top u) + div(h_deep u) ) / rms(div(h_top u)) = 1.92   (expected ≈ 0)
```

They are essentially **uncorrelated**: the deep layer does not return the
top-layer transport, so the depth-integrated (barotropic) flow is strongly
divergent even though the model assumes a fixed column depth `D`
(`h_deep = D − h_top`) — a latent rigid-lid assumption nothing enforces.

## Root cause
In `OCEAN_FS` the two layers are driven by very different pressure gradients:

```
accT = -uPgfTop · grad(eta) + ...      uPgfTop = 9.81   (a stand-in for the
accD = +pgfDeepGain·g' · grad(eta) + ...  g' ≈ 3e-3…1e-2  surface pressure the
                                                         model never carries)
```

So the top is pushed ~1000× harder than the deep by the same interface slope.
There is **no barotropic (surface) pressure** shared by both layers, hence no
mechanism to make the column non-divergent. This is called out in the code
itself: *"the full-g value acts as a stand-in for the barotropic/free-surface
pressure this rigid-lid model does not carry."*

## Bug found along the way (fixed)
While instrumenting the implicit solver I found scheme B's Jacobi loop bound the
eta texture with `this[src]` where `src = 'etaA'` — but the textures are
`this.texEtaA/B` (only the *FBOs* are `this.fbo.etaA/B`). `this.etaA` is
`undefined`, so `uEtaIn`/`uEta` sampled a **null texture (all zeros)**: scheme B's
entire implicit free-surface solve was a silent no-op (it ran predictor-only,
with zero pressure gradient). Fixed by binding `this.texEtaA/B` explicitly. The
same idiom was used in the new barotropic solver and is now correct. (Scheme 0,
the default, never used this path and is byte-unchanged.)

## The refactor — barotropic (rigid-lid) projection  [opt-in: `rigidLid`]
A Chorin pressure projection, run on the post-couple state each step
(`projectBarotropic`, shaders `BARO_*`):

1. `b = div(U*)`, `U* = h_top·u_top + h_deep·u_deep` (provisional transport).
2. Solve `lap(phi) = b` by damped Jacobi (warm-started across substeps via a
   persistent `texPhi`).
3. Correct **both** layers by the same depth-independent velocity
   `du = grad(phi)/D`. This preserves the shear `u_top − u_deep` (the
   baroclinic/overturning mode) and adds the missing barotropic return flow to
   the deep layer — `phi` is the surface pressure the model was faking.

Measured effect (60 steps, off → on):

```
corr:        -0.03  →  -0.43        (layers now anti-correlated: real return flow)
max deep spd  0.007 →   0.034 m/s   (deep return limb 4–5× stronger)
column-div ratio 1.92 → 1.85        (only mildly reduced — see limitation)
NaNs 0 ; max top speed unchanged (2.02) ; stable over 150 steps.
```

Default is **off**, so the tuned climate and regression baselines are unchanged;
enable it (checkbox "Rigid-lid (deep return flow)" or `params.rigidLid=1`) to opt
in.

## Honest limitation (and the real next step)
Increasing the Jacobi count does **not** drive `corr → −1` — it plateaus near
−0.4. Reason: the correction subtracts a **cell-centred** gradient, while the
divergence lives in the **compact/face** operator. On a collocated grid these
differ by the odd-even (checkerboard) null space — exactly what **Rhie–Chow**
exists to fix (and which this codebase already applies to the *top-layer*
pressure). A cell-centred projection can only remove the part of the divergence
the wide Laplacian sees, so it strengthens the deep return flow and roughly
halves the imbalance, but cannot reach exact column mass balance.

**To fully close it** (`div(U) = 0`, `corr → −1`) the projection must act on
**Rhie–Chow face-normal transports** consistently for both layers (a
staggered/face-flux formulation), i.e. the barotropic solve should be integrated
into the timestep the way the scheme-B free-surface solve is, rather than as a
post-hoc cell-velocity correction. That is a larger solver rewrite; flagged for a
follow-up rather than risking the tuned climate now.

## Verification
- `harness/render.js` — 24 programs compiled, 36 draws, 0 failures.
- Scheme 0 (default) with rigid-lid off: byte-unchanged; no NaN.
- Scheme B (implicit solve now functional): stable, no NaN over 40 steps.
