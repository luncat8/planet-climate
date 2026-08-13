/* params.js - single source of truth for parameters + pure preset/model helpers.
   Loaded before engine.js and app.js. No DOM dependencies. */

/* Every tunable parameter's metadata (label, default, min/max/step, formatting)
   plus the default value of every other parameter. `defaultParams()` is derived
   from this so there is exactly one definition. */
var PARAMS = {
  // tunable (have min/max/step) -> become sliders
  dt:        { label: 'Timestep dt',          default: 60,   min: 1, max: 900, step: 1,   fmt: function (v) { return v + ' s'; } },
  substeps:  { label: 'Substeps / frame',     default: 8,     min: 1,   max: 128,    step: 1 },
  /* Physical spin rate (rad/s) — drives the real 3-D Coriolis force. A tidally
     locked planet still rotates once per orbit in the inertial frame, so this
     should generally stay non-zero even when omegaOrbit = 0. */
  omegaSpin: { label: 'Spin Ω (Coriolis)',    default: 7.292e-5, min: 0, max: 3.6e-4, step: 1e-6, fmt: function (v) { return (v / 7.292e-5).toFixed(2) + '× Earth'; } },
  /* Apparent angular rate (rad/s) of the sub-solar point sliding across the
     surface — i.e. the day/night cycle. Independent of omegaSpin: set to 0 to
     freeze the sun (tidal lock) while Coriolis keeps spinning. */
  omegaOrbit:{ label: 'Sun angular rate',     default: 6.2831853 / 86400, min: 0, max: 3e-4, step: 1e-6,
               fmt: function (v) { return v > 1e-8 ? (6.2831853 / v / 3600).toFixed(1) + ' h/day' : 'frozen (locked)'; } },
  solar:     { label: 'Solar constant',       default: 1361,  min: 800, max: 4000, step: 10,   fmt: function (v) { return v + ' W/m²'; } },
  greenhouse:{ label: 'Greenhouse factor',    default: 0.55,  min: 0,   max: 1,    step: 0.01 },
  /* ---- PLANET-SCALE PHYSICS (Earth-tuned defaults; exposed so non-Earth
      bodies can be simulated). All downstream shaders read these as uniforms
      (uGravity, uSurfacePressure via uPlow/uPhigh, uRhoLo, planet-radius), so the
      default values reproduce the original Earth behaviour exactly. */
  gravity:       { label: 'Surface gravity',    default: 9.81,    min: 0.1, max: 30,     step: 0.01, fmt: function (v) { return v.toFixed(2) + ' m/s²'; } },
  surfacePressure:{ label: 'Surface pressure',  default: 101325,  min: 0,   max: 2e7,    step: 1000, fmt: function (v) { return (v / 1000).toFixed(v < 1e4 ? 3 : 0) + ' kPa'; } },
  atmosDensity:  { label: 'Air density (low)',  default: 1.1,     min: 0,   max: 200,     step: 0.1,  fmt: function (v) { return v.toFixed(3) + ' kg/m³'; } },
  planetRadius:  { label: 'Planet radius',      default: 6371e3,  min: 1e5, max: 1e7,     step: 1e3,  fmt: function (v) { return (v / 1000).toFixed(0) + ' km'; } },
  nuVelAir:  { label: 'Air viscosity ν',      default: 1.6e5, min: 0,   max: 6e5,  step: 1e4,  fmt: function (v) { return v.toExponential(1); } },
  nuTAir:    { label: 'Air heat diffusion',   default: 1.1e5, min: 0,   max: 6e5,  step: 1e4,  fmt: function (v) { return v.toExponential(1); } },
  /* 1.6e-5 s^-1 is a 17-hour e-folding — any free vortex dies before it can
     propagate. 4e-6 (~3 days) is still stronger than a bulk Ekman layer on a
     5 km column, but it lets synoptic eddies live long enough to move. */
  fricAirLow:{ label: 'Surface friction',     default: 4e-6, min: 0,   max: 8e-5, step: 1e-6, fmt: function (v) { return v.toExponential(1); } },
  /* Equivalent gravity-wave speed for the prognostic air pressure
     (baroclinic shallow-water analog, c = sqrt(g He)). 0 = legacy
     diagnostic P(T) only — vortices then sit still, slaved to T.
     ~40 m/s → He ≈ 160 m, mid-lat deformation radius ~400 km. */
  airCs:     { label: 'Air wave speed c',     default: 40,   min: 0, max: 120, step: 2,
    fmt: function (v) { return v <= 0 ? 'diagnostic P' : v.toFixed(0) + ' m/s'; },
    tip: 'Prognostic air pressure wave speed. 0 restores the old T-only diagnostic P (static cells).' },
  /* Rate (1/s) at which prognostic P is nudged toward the thermal
     diagnostic. ~8e-6 ≈ 1.5 day: Hadley/Walker stay thermally driven,
     synoptic anomalies are not instantly overwritten. */
  airPRelax: { label: 'Air P thermal relax',  default: 8e-6, min: 0, max: 5e-5, step: 1e-6,
    fmt: function (v) { return v <= 0 ? 'off' : (1 / v / 86400).toFixed(1) + ' d'; },
    tip: 'How fast prognostic P is pulled toward the thermal P(T). Slower = freer weather.' },
  airFbStab: { label: 'Air gravity-wave stab.', default: 20, min: 0, max: 100, step: 1,
    tip: 'Forward-backward damper for the explicit air (P, u) gravity wave. Same idea as the ocean fbStab. 0 = plain explicit.' },
  /* Hydrostatic column: ρ g H / T ≈ 1.1*9.81*5000/288 ≈ 187 Pa/K.
     The old 60 Pa/K produced a ~1.6 m/s thermal wind — too weak for
     baroclinic instability to beat friction, so cells sat still. */
  airDpdT:   { label: 'Air dP/dT (low)',      default: 180,  min: 0, max: 400, step: 5,
    fmt: function (v) { return v.toFixed(0) + ' Pa/K'; },
    tip: 'How strongly low-air temperature sets the thermal pressure target. Larger = stronger jet, more mobile eddies.' },
  airDpdTHi: { label: 'Air dP/dT (high)',     default: 200,  min: 0, max: 500, step: 5,
    fmt: function (v) { return v.toFixed(0) + ' Pa/K'; },
    tip: 'High-air thermal pressure coefficient. Larger = stronger upper jet.' },
  /* Face Courant cap for the explicit air advection. The air momentum/tracer
     advection in stepAir is explicit upwind, so its effective Courant |u|*dt/d
     grows with dt; at large dt the upwind scheme over-diffuses (spuriously
     damps winds), at small dt it is "clean" (higher winds) -> a dt-dependent
     bias. Capping the per-face Courant here forces large-dt air to behave like
     small-dt air, removing the bias. 0.5 is a conservative starting point. */
  airCourantMax:{ label: 'Air Courant cap',     default: 0.5, min: 0.05, max: 2, step: 0.05,
                  fmt: function (v) { return v.toFixed(2); } },
  /* Selectable air advection algorithm (comparison scaffold; FV is default):
       0 = Capped finite-volume upwind (Phases 2-3, dt-independent).
       1 = Semi-Lagrangian back-trajectory sampling (A/B only, not default). */
  airAdvect:    { label: 'Air advection',       default: 0, min: 0, max: 1, step: 1,
                  opts: [
                    { v: 0, label: 'Capped FV (default)' },
                    { v: 1, label: 'Semi-Lagrangian' },
                  ] },
  conv:      { label: 'Convection gain',      default: 6e-6,  min: 0,   max: 3e-5, step: 5e-7, fmt: function (v) { return v.toExponential(1); } },
  kRad:      { label: 'Radiative exchange',   default: 2.5,   min: 0,   max: 8,    step: 0.1 },
  lapse:     { label: 'Reference lapse ΔT',   default: 45,    min: 20,  max: 70,   step: 1,    fmt: function (v) { return v + ' K'; } },
  evap:      { label: 'Evaporation k',        default: 0.005, min: 0,   max: 0.02, step: 0.0005, fmt: function (v) { return v.toFixed(4); } },
  kSurf:     { label: 'Sensible heat k',      default: 22,    min: 0,   max: 60,   step: 1,    fmt: function (v) { return v + ' W/m²K'; } },
  windStress:{ label: 'Wind stress (air-side)', default: 2e-6, min: 0, max: 1e-5, step: 1e-7, fmt: function (v) { return v.toExponential(1); } },
  thermo:    { label: 'Thermohaline mixing',  default: 2e-7,  min: 0,   max: 2e-6, step: 2e-8, fmt: function (v) { return v.toExponential(1); } },
  /* Inter-layer mechanical drag coefficient (kg/m^3/s). The shear stress
     tau = (oceanDrag + mechanicalFric) * |u_top - u_deep| * (u_top - u_deep)
     is applied equally and oppositely to the two layers, weighted by inverse
     column mass (rho*h), so total ocean momentum is conserved exactly. */
  oceanDrag:      { label: 'Inter-layer drag r',    default: 2.5e-3, min: 0, max: 2e-2, step: 5e-5, fmt: function (v) { return v.toExponential(1); } },
  /* Purely mechanical friction between the layers: identical in form to
     oceanDrag but conceptually independent of the density stratification
     (unlike the thermohaline exchange). Combined into one effective coeff. */
  mechanicalFric: { label: 'Mechanical friction',   default: 1e-3, min: 0, max: 5e-3, step: 1e-4, fmt: function (v) { return v.toExponential(1); } },
  /* Steric (thermal/haline expansion) amplitude, in metres of extra top-layer
     thickness per unit buoyancy anomaly (alphaT*dT - betaS*dS). This is what
     turns the T/S field into a sea-surface-height field and hence drives the
     surface circulation; the deep layer then feels the opposite gradient. */
  steric:         { label: 'Steric height gain',    default: 500, min: 0, max: 5000, step: 50, fmt: function (v) { return v.toExponential(1); } },
  /* Rate (1/s) at which h_top relaxes toward its steric equilibrium. */
  stericRate:     { label: 'Steric relax rate',     default: 1e-6, min: 0, max: 1e-5, step: 1e-7, fmt: function (v) { return v.toExponential(1); } },
  /* Extra mass correction (1/s) on top of the steric relaxation: nudges h_top
     back toward the plain reference thickness H_ref. The steric relaxation
     (stericRate) is what actually stabilises the interface; this term only
     removes any residual bias, so it needs a timescale of months-to-years
     (~1e-8 = 3 yr) to do anything at all on simulated timescales. */
  massSpring:     { label: 'Mass spring (global)',  default: 1e-8, min: 0, max: 1e-7, step: 1e-9, fmt: function (v) { return v.toExponential(1); } },
  /* Extra uniform surface mass forcing on h_top (m/s), on top of E-P. Useful
     to probe the mass budget; positive thins the top layer. */
  surfMass:       { label: 'Surface mass forcing',  default: 0, min: -1e-6, max: 1e-6, step: 5e-8, fmt: function (v) { return v.toExponential(1); } },
  /* Vertical heat exchange coefficient (W/m^2/K): Q = k*(T_deep - T_top),
     applied symmetrically in heat-content form (top gains, deep loses). */
  verticalHeat:   { label: 'Vertical heat k',       default: 0.9, min: 0, max: 10, step: 0.05, fmt: function (v) { return v.toFixed(2) + ' W/m²K'; } },
  /* Vertical salt exchange coefficient (kg/m^2/s per ppt), symmetric. */
  verticalSalt:   { label: 'Vertical salt k',       default: 5e-7, min: 0, max: 5e-5, step: 5e-7, fmt: function (v) { return v.toExponential(1); } },
  nuVelOcean:{ label: 'Ocean viscosity',      default: 6e3,   min: 0,   max: 4e4,  step: 1e3,  fmt: function (v) { return v.toExponential(1); } },

  /* ---- OCEAN GEOMETRY (per-cell depth / reference thickness) --------------
     The ocean used to be a slab of uniform total depth hTotal with a uniform
     reference top-layer thickness hTop. Both are now per-cell fields carried
     in the static uCellC texture; these knobs shape them. */
  /* Pressure-gradient gain on the TOP layer. The 1.5-layer shallow-water
     result would be g' (~0.02), but this model has a rigid lid and no free
     surface, so the full g here acts as a barotropic-pressure proxy that is
     what actually produces realistic surface currents. Exposed rather than
     hard-coded so it can be rebalanced without editing GLSL. */
  /* Rhie-Chow face-velocity smoothing. Removes the collocated-grid odd-even
     (checkerboard) null mode, which is invisible to the mass equation and
     therefore undamped at ANY timestep. ~0.25 is enough; 0 = legacy stencil. */
  rhieChow:   { label: 'Rhie-Chow damping',   default: 1.0,   min: 0, max: 4, step: 0.05,
    tip: 'Suppresses grid-scale checkerboard noise. 0 reproduces the old A-grid stencil.' },
  fbStab:     { label: 'Gravity-wave stab.',  default: 30,    min: 0, max: 100, step: 1,
    tip: 'Forward-backward correction for the explicit gravity-wave pair, needed at level 6-7 or large dt. Self-limiting: it targets cells where the timestep is actually stiff, so raising it does not damp coarse grids. 0 = legacy explicit scheme.' },
  pgfTop:     { label: 'PGF gain (top)',      default: 9.81,  min: 0, max: 20, step: 0.05,
                fmt: function (v) { return v.toFixed(2); } },
  /* Multiplier on the deep layer's +g'*grad(eta) return-limb forcing. */
  pgfDeepGain:{ label: 'PGF gain (deep)',     default: 1.0,  min: 0, max: 4,  step: 0.05,
                fmt: function (v) { return v.toFixed(2) + '×'; } },
  /* Switchable ocean calc engine (PLAN.md Phase 10):
        0 = Explicit (Current)  — planet2a2 OCEAN_FS, fbStab + Rhie-Chow
        1 = Decoupled (A)        — drop div(h*u) from continuity; unconditionally
                                   stable, no tuning slider, zero extra passes
        2 = Implicit (B)         — proper implicit free surface solved by Jacobi
                                   iteration each step (implicitIters passes)
      Rendered as a dropdown in the UI; changing it needs no rebuild (uniform-only). */
  oceanScheme:{ label: 'Ocean scheme', default: 0, min: 0, max: 2, step: 1,
    opts: [
      { v: 0, label: 'Explicit (Current)' },
      { v: 1, label: 'Decoupled (Stable/Fast)' },
      { v: 2, label: 'Implicit (Physical/Slow)' },
    ] },
  /* Jacobi iterations for scheme B (implicit free surface). Hard ceiling; the
     engine early-exits once the residual drops below 1e-6, so cheap levels do
     not pay for all of them. Only meaningful when oceanScheme == 2. */
  implicitIters:{ label: 'Implicit iters (B)', default: 12, min: 1, max: 40, step: 1,
    tip: 'Jacobi iterations for the implicit free surface (scheme B). Greyed out for schemes 0/1.' },
  /* Barotropic (rigid-lid) projection: enforces div(h_top u_top + h_deep u_deep)
     = 0 each step so the two ocean layers mass-balance (deep = true return
     flow). Off by default — it changes the tuned currents. Works with any
     ocean scheme. baroIters = Jacobi sweeps of the barotropic pressure solve. */
  rigidLid:   { label: 'Rigid-lid (deep return flow)', default: 0 },
  baroIters:  { label: 'Barotropic iters', default: 8, min: 4, max: 100, step: 4,
    tip: 'Jacobi sweeps for the barotropic projection (warm-started across substeps, so a few suffice). Cell-centred projection plateaus near corr -0.4; full closure needs a staggered face-flux solver.' },
  /* Maximum (abyssal) ocean depth. Reached far from any coastline. */
  depthMax:   { label: 'Max ocean depth',     default: 4000,  min: 500, max: 8000, step: 100,
                fmt: function (v) { return (v / 1000).toFixed(1) + ' km'; } },
  /* Width of the continental shelf/slope, i.e. the distance over which depth
     ramps from dShelf up to depthMax. */
  shelfWidth: { label: 'Shelf width',         default: 250e3, min: 0, max: 800e3, step: 25e3,
                fmt: function (v) { return (v / 1000).toFixed(0) + ' km'; } },
  /* How much of the fbm terrain field modulates the depth profile (ridges,
     trenches, seamounts). 0 = perfectly smooth shelf->abyss ramp. */
  bathyRough: { label: 'Bathymetry roughness', default: 0.35, min: 0, max: 1, step: 0.05,
                fmt: function (v) { return v.toFixed(2); } },
  /* Quadratic bottom-drag coefficient: the effective linear rate is
     Cd*|u|/h, so the SAME Cd damps a 30 m shelf column ~100x harder than a
     4 km abyssal one -- which is the physical point of the depth dependence. */
  cdBottom:   { label: 'Bottom drag Cd',      default: 2.5e-3, min: 0, max: 1e-2, step: 1e-4,
                fmt: function (v) { return v.toExponential(1); } },
  /* Critical gradient Richardson number: above this the interface is
     considered stratified enough to suppress shear-driven exchange. */
  riCrit:     { label: 'Richardson crit',     default: 0.25,  min: 0.05, max: 2, step: 0.05,
                fmt: function (v) { return v.toFixed(2); } },
  /* Mixing multiplier applied when the column is statically UNSTABLE
     (dense water over light water) -- i.e. convective overturning. */
  mixConv:    { label: 'Convective mixing',   default: 50,    min: 1, max: 500, step: 5,
                fmt: function (v) { return v.toFixed(0) + '×'; } },
  cloudK:    { label: 'Cloud sensitivity',    default: 1.7,   min: 0,   max: 4,    step: 0.05 },
  noise:     { label: 'Symmetry-break noise', default: 0.02,  min: 0,   max: 0.2,  step: 0.005 },
  // non-tunable (default only; UI handled by checkboxes / mode / equirect buttons)
  running:        { default: true },
  /* Ocean geometry: reference top-layer thickness and fixed total depth (m).
     h_deep = hTotal - h_top is derived, so total ocean volume never changes. */
  /* ~60 m is a realistic mixed-layer depth; the surface heat capacity is now
     derived from it (cp*rho*h_top) so heat exchange stays conservative. */
  hTop:           { label: 'Ref mixed-layer h', default: 60, min: 20, max: 200, step: 5,
    tip: 'Reference top-layer thickness (m). Per-cell h_ref is capped by local depth.' },
  hTotal:         { label: 'Slab total depth', default: 1000, min: 200, max: 6000, step: 100,
    tip: 'Ocean depth used when bathyMode = 0 (flat slab).' },
  /* Bathymetry source: 0 = flat legacy slab (D == hTotal everywhere, exactly
     reproduces the pre-refactor ocean), 1 = procedural shelf/slope/abyss. */
  bathyMode:      { label: 'Bathymetry mode', default: 1, min: 0, max: 1, step: 1,
    tip: '0 = flat legacy slab, 1 = procedural shelf/slope/abyss.' },
  /* Nominal minimum thickness of either layer (m). Was the literal 40.0
     repeated in 8 places in shader.js; on a shallow shelf it is scaled down
     per-cell by hLimits() so the clamp range can never invert. */
  hMin:           { label: 'Min layer thickness', default: 40, min: 5, max: 100, step: 5,
    tip: 'Nominal floor on either layer (m); scaled down per-cell on shallow shelves.' },
  /* Depth (m) below which a column is treated as a well-mixed shelf sea
     rather than a two-layer stratified ocean. */
  dShelf:         { label: 'Shelf depth', default: 200, min: 30, max: 1000, step: 10,
    tip: 'Depth (m) below which a column is treated as a well-mixed shelf sea.' },
  /* Reference depth for the linear (background) friction taper: the legacy
     depth-blind rate is scaled by fricDepthRef/max(D, fricDepthRef), so the
     abyss is no longer damped as hard as a 60 m surface layer. */
  fricDepthRef:   { label: 'Friction depth ref', default: 1000, min: 100, max: 5000, step: 100,
    tip: 'Background friction is scaled by this/max(D, this), so the abyss is not over-damped.' },
  /* Deterministic seed for grid generation AND state initialisation. Was
     Math.random() in reset(), which made runs unreproducible. */
  /* Crank-Nicolson Coriolis. The explicit rotation multiplies |v| by
     sqrt(1+(f*dt)^2) EVERY step -- a compounding gain that peaks at the poles
     (f ~ sin(lat)), which is what made the instability grow from the caps.
     CN is norm-preserving for any f*dt. false = legacy explicit. */
  coriCN:         { default: true },
  seed:           { default: 12345 },
  nuTOcean:       { default: 4e3 },
  fricAirHigh:    { default: 2.5e-6 },
  fricOceanTop:   { default: 1.5e-6 },
  fricOceanDeep:  { default: 6e-7 },
  rainK:          { default: 2200 },
  dayNight:       { default: 1 },
  mode:           { default: 0 },
  showClouds:     { default: true },
  streamline:     { default: 2 },
  streamTrail:    { label: 'Streamline length', default: 6000, min: 0, max: 30000, step: 500,
                    fmt: function (v) { return v <= 0 ? 'dots' : (v / 60).toFixed(0) + ' min'; } },
  /* ---- Flow visualisation toolbox (combinable rendering methods) ----------
     None of these touch the physics; they only change how the streamline /
     particle layer is advected and drawn. */
  flowParticles:  { label: 'Particle count', default: 16, min: 2, max: 64, step: 2,
                    fmt: function (v) { return (v | 0) + 'k'; } },
  flowAvg:        { label: 'Time-averaged flow', default: 1 },
  flowSmooth:     { label: 'Averaging strength', default: 0.9, min: 0, max: 0.98, step: 0.01,
                    fmt: function (v) { return Math.round(v * 100) + '%'; } },
  flowLines:      { label: 'Continuous trails', default: 1 },
  flowSegs:       { label: 'Trail length', default: 24, min: 2, max: 40, step: 1,
                    fmt: function (v) { return String(v | 0); } },
  flowRecycle:    { label: 'Move between layers', default: 1 },
  flowMix:        { label: 'Layer-mixing rate', default: 1.0, min: 0, max: 3, step: 0.1,
                    fmt: function (v) { return (+v).toFixed(1) + '×'; } },
  flowLife:       { label: 'Lifetime (days)', default: 20, min: 1, max: 90, step: 1,
                    fmt: function (v) { return (v | 0) + 'd'; } },
  flowUniform:    { label: 'Even out speed', default: 0 },
  flowGain:       { label: 'Flow gain', default: 1, min: 0.2, max: 8, step: 0.1,
                    fmt: function (v) { return (+v).toFixed(1) + '×'; } },
  showLand:       { default: 1 },
  nightShading:   { default: 1 },
  relief:         { default: 0.004 },
  equirect:       { default: 0 },
};

/* Built-in presets: keyed maps of partial overrides ({ v?, min?, max?, step? }).
   Applying one only touches the listed keys; all other params stay intact. */
var BUILTIN_PRESETS = {
  'Default': null, // sentinel: means "restore defaults"
  'Earth-like': {
    dt: { v: 300 }, solar: { v: 1361 }, greenhouse: { v: 0.55 },
    omegaSpin: { v: 7.292e-5 }, omegaOrbit: { v: 6.2831853 / 86400 },
    evap: { v: 0.005 }, cloudK: { v: 1.7 }, noise: { v: 0.02 },
  },
  'Slow rotation': {
    omegaSpin: { v: 1.8e-5, min: 0, max: 3.6e-4, step: 1e-6 },
    omegaOrbit: { v: 1.8e-5, min: 0, max: 3e-4, step: 1e-6 },
    lapse: { v: 55 }, conv: { v: 9e-6 },
  },
  'Tidally locked': {
    omegaSpin: { v: 7.292e-5 }, omegaOrbit: { v: 0 },
    lapse: { v: 55 },
  },
  'Hothouse': {
    solar: { v: 1700 }, greenhouse: { v: 0.85 }, evap: { v: 0.012, min: 0, max: 0.03, step: 0.0005 },
    kRad: { v: 1.2 }, cloudK: { v: 2.6 },
  },
  'Test Ocean Coupling': {
    /* Усиливаем передачу импульса от ветра к воде (default 2e-6) */
    windStress:     { v: 6e-6 },
    
    /* Глубинный слой сильнее реагирует на градиенты высоты поверхности (default 1.0) */
    pgfDeepGain:    { v: 1.8 },
    
    /* Уменьшаем трение о дно в абиссали, чтобы глубинные течения не гасли мгновенно (default 2.5e-3) */
    cdBottom:       { v: 1.5e-3 },
    
    /* Увеличиваем поверхностное трение воздуха для более реалистичного приземного слоя (default 4e-6) */
    fricAirLow:     { v: 3e-5 },
    
    /* Усиливаем связь между верхним и глубинным слоем океана (default sum ~3.5e-3 -> new ~5.5e-3) */
    oceanDrag:      { v: 4e-3 },
    mechanicalFric: { v: 1.5e-3 }
  },
  'Mobile weather': {
    airCs: { v: 45 }, airPRelax: { v: 5e-6 }, fricAirLow: { v: 3e-6 },
    nuVelAir: { v: 8e4 }, noise: { v: 0.04 },
  },
  'Vivid Ocean': {
    /* Уменьшаем горизонтальную вязкость океана (default 6e3) → меньше сглаживания, живее фронты */
    nuVelOcean:     { v: 3e3 },

    /* Снижаем трение верхнего слоя (default 1.5e-6) и дна (default 2.5e-3) → течения дольше живут */
    fricOceanTop:   { v: 8e-7 },
    cdBottom:       { v: 1.0e-3 },

    /* Усиливаем стерический драйв: больше связи T/S ↔ высота поверхности (default steric=500, rate=1e-6) */
    steric:         { v: 800 },
    stericRate:     { v: 2e-6 },

    /* Усиливаем вертикальный обмен и термохалинную циркуляцию */
    verticalHeat:   { v: 1.5 },
    thermo:         { v: 4e-7 },

    /* Чуть сильнее ветер давит на воду (default windStress=2e-6) */
    windStress:     { v: 3e-6 },

    /* Немного больше шума для разрыва симметрии и появления структур (default 0.02) */
    noise:          { v: 0.04 }
  },

  /* ---- PLANET PRESETS -------------------------------------------------
     Earth is the reference baseline (the other presets are meant to be compared
     against it). Moon and Venus exercise the new planet-scale physics params:
     gravity, surfacePressure, atmosDensity and planetRadius. Non-Earth bodies
     keep the default ocean geometry (the engine always carries ocean layers),
     but the air column is scaled by pressure/density/gravity so the climate
     responds correctly. */
  'Earth': {
    gravity:        { v: 9.81 },
    surfacePressure:{ v: 101325 },
    atmosDensity:   { v: 1.1 },
    planetRadius:   { v: 6371e3 },
    greenhouse:     { v: 0.55 },
    omegaSpin:      { v: 7.292e-5 },
    omegaOrbit:     { v: 6.2831853 / 86400 },
    solar:          { v: 1361 },
  },
  /* Moon: low gravity, (at least tiny surface pressure and air
     density so the fluid solver stays finite), slow-ish rotation, Earth-like
     insolation from the Sun. 
     we apply 'terraformed Moon' pressure.
     */
  'Moon': {
    gravity:        { v: 1.62 },
    surfacePressure:{ v: 50000 },
    atmosDensity:   { v: 0.8 },
    planetRadius:   { v: 1737e3 },
    greenhouse:     { v: 0.0 },
    /* omegaSpin is the sidereal rotation rate (~27.3 d) that drives Coriolis.
       omegaOrbit is the SUN's apparent sweep = the synodic lunar day (~29.53 d),
       i.e. the real day/night cycle on the Moon, not the sidereal spin period. */
    omegaSpin:      { v: 2 * Math.PI / (27.3 * 86400) },
    omegaOrbit:     { v: 2 * Math.PI / (29.53 * 86400) },
    solar:          { v: 1361 },
    depthMax:       { v: 200 },
  },
  /* Venus: ~0.9 g, very high surface pressure (CO2) and dense low-air column,
     strong greenhouse (hot), very slow rotation, ~1.9x Earth insolation. */
  'Venus': {
    gravity:        { v: 8.87 },
    surfacePressure:{ v: 9.2e6 },
    atmosDensity:   { v: 65 },
    planetRadius:   { v: 6052e3 },
    greenhouse:     { v: 1.0 },
    omegaSpin:      { v: 3e-7 },
    omegaOrbit:     { v: 2 * Math.PI / (225 * 86400) },
    solar:          { v: 2614 },
    depthMax:       { v: 200 },
  },

};

function defaultParams() {
  var o = {};
  Object.keys(PARAMS).forEach(function (k) { o[k] = PARAMS[k].default; });
  return o;
}

/* Effective slider bounds for a key: per-instance override (from a preset)
   merged over the static PARAMS schema. */
function boundsOf(p, key) {
  var s = PARAMS[key];
  var o = p && p.bounds && p.bounds[key];
  return {
    min: o && o.min !== undefined ? o.min : s.min,
    max: o && o.max !== undefined ? o.max : s.max,
    step: o && o.step !== undefined ? o.step : s.step,
  };
}
function setBound(p, key, part) {
  if (!p.bounds) p.bounds = {};
  var cur = p.bounds[key] || {};
  if (part.min !== undefined) cur.min = part.min;
  if (part.max !== undefined) cur.max = part.max;
  if (part.step !== undefined) cur.step = part.step;
  p.bounds[key] = cur;
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/* Normalize a preset source into a keyed map { key: { v?, min?, max?, step? } }.
   Accepts either an object keyed by param key, or an array of entries each
   carrying a `key` field. */
function normalizePreset(src) {
  if (!src) return {};
  if (Array.isArray(src)) {
    var m = {};
    src.forEach(function (e) {
      if (e && e.key) {
        var o = {};
        if (e.v !== undefined) o.v = e.v;
        if (e.min !== undefined) o.min = e.min;
        if (e.max !== undefined) o.max = e.max;
        if (e.step !== undefined) o.step = e.step;
        m[e.key] = o;
      }
    });
    return migrateKeys(m);
  }
  return migrateKeys(src);
}

/* Backwards compatibility: the old single `omega` drove BOTH the Coriolis term
   and the sub-solar point, so an old preset/save maps onto both new keys. */
function migrateKeys(m) {
  if (!m || m.omega === undefined) return m;
  var out = {}, k;
  for (k in m) if (k !== 'omega') out[k] = m[k];
  if (out.omegaSpin === undefined) out.omegaSpin = m.omega;
  if (out.omegaOrbit === undefined) out.omegaOrbit = m.omega;
  return out;
}
