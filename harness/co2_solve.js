/* co2_solve.js — offline 0-D carbon-cycle solver (no GPU, no puppeteer).
 *
 * Reduced model of the live GPU system: greenhouse(CO2) -> mean T -> ice ->
 * weathering/ocean/biosphere fluxes -> CO2. Used to (a) auto-balance volcanism
 * against weathering at the target CO2, (b) find whether the silicate-weathering
 * + ice-albedo loop gives a self-sustained (ice-age) oscillation, (c) recommend
 * the co2Speed (geological years per physics step) so one cycle plays over ~N
 * steps. Run: `node co2_solve.js`.
 */
'use strict';

const P = {
  Cref: 280, Tref: 288, g0: 0.55, s: 0.09,   // greenhouse = g0 + s*ln(Ca/Cref)
  aG: 45, aI: 13,                              // T = Tref + aG*(green-g0) - aI*I
  Tice: 288.5, wIce: 6, Imax: 0.7, kIce: 1 / 1500, // ice: dI/dt=kIce*(Ieq-I)
  landFrac: 0.29,
  W0: 0.09, kW: 0.055,                         // weathering
  Kao: 0.0008, kH: 0.03,                        // ocean (Henry) — weak by default
  B0: 0.5, Chalf: 150, Kcap: 1000, R0: 0.02,   // biosphere
  Topt: 290, Tw: 12,
};

function greenhouse(Ca) { return P.g0 + P.s * Math.log(Ca / P.Cref); }
function temp(Ca, I) { return P.Tref + P.aG * (greenhouse(Ca) - P.g0) - P.aI * I; }
function Ieq(T) { return Math.max(0, Math.min(P.Imax, (P.Tice - T) / P.wIce)); }
function suit(T) { const d = (T - P.Topt) / P.Tw; return Math.exp(-d * d); }

function fluxes(Ca, Cb, I, V0) {
  const T = temp(Ca, I);
  const iceFreeLand = P.landFrac * (1 - I);
  const weather = P.W0 * iceFreeLand * Math.exp(P.kW * (T - P.Tref)) * (Ca / P.Cref);
  const ocean = P.Kao * (P.Cref * Math.exp(P.kH * (T - P.Tref)) - Ca);
  const npp = P.B0 * suit(T) * (Ca / (Ca + P.Chalf)) * Math.max(0, 1 - Cb / P.Kcap);
  const resp = P.R0 * Cb;
  const volc = V0;
  return { T, weather, ocean, npp, resp, volc,
    dCa: volc - weather + ocean - npp + resp, dI: P.kIce * (Ieq(T) - I), dCb: npp - resp };
}

// Balance volcanism by bisection so the long-run MEAN CO2 lands on the target,
// accounting for the true (possibly cold/icy) attractor rather than the naive
// reference point.
function meanCa(V0) {
  const h = integrate(V0, 400000, 20, P.Cref, 400, 0.0);
  const tail = h.slice(Math.floor(h.length * 0.5));
  return tail.reduce((s, p) => s + p.Ca, 0) / tail.length;
}
function balanceV0() {
  let lo = 1e-4, hi = 1.0;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (meanCa(mid) < P.Cref) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function integrate(V0, years, h, Ca0, Cb0, I0) {
  let Ca = Ca0, Cb = Cb0, I = I0; const hist = [];
  const n = Math.round(years / h);
  for (let k = 0; k < n; k++) {
    const f = fluxes(Ca, Cb, I, V0);
    Ca += h * f.dCa; Cb += h * f.dCb; I += h * f.dI;
    Ca = Math.max(1, Ca); Cb = Math.max(0, Cb); I = Math.max(0, Math.min(P.Imax, I));
    hist.push({ t: k * h, Ca, Cb, I, T: f.T });
  }
  return hist;
}

// Detect oscillation from the last 60% of a trajectory: amplitude + period (zero-crossings of Ca-mean).
function analyze(hist) {
  const tail = hist.slice(Math.floor(hist.length * 0.4));
  let mn = 1e9, mx = -1e9, sum = 0;
  for (const p of tail) { mn = Math.min(mn, p.Ca); mx = Math.max(mx, p.Ca); sum += p.Ca; }
  const mean = sum / tail.length, amp = (mx - mn) / 2;
  // period via mean crossings (rising)
  const cross = [];
  for (let i = 1; i < tail.length; i++)
    if (tail[i - 1].Ca < mean && tail[i].Ca >= mean) cross.push(tail[i].t);
  let period = null;
  if (cross.length >= 2) {
    let d = 0; for (let i = 1; i < cross.length; i++) d += cross[i] - cross[i - 1];
    period = d / (cross.length - 1);
  }
  return { mean: +mean.toFixed(1), amp: +amp.toFixed(1), period, Tmin: Math.min(...tail.map(p=>p.T)), Tmax: Math.max(...tail.map(p=>p.T)) };
}

const V0 = balanceV0();
console.log('Balanced volcanism V0 =', V0.toFixed(5), 'ppm/yr  (long-run mean CO2 -> Cref)');

// Long integration from a warm perturbation to reveal the attractor.
const H = 20, YEARS = 600000;
const hist = integrate(V0, YEARS, H, P.Cref * 1.5, 400, 0.0);
const a = analyze(hist);
console.log('Attractor over', YEARS, 'yr:', JSON.stringify(a),
  '(T range', a.Tmin.toFixed(1), '..', a.Tmax.toFixed(1), 'K)');

// Scan for an oscillatory (ice-age) regime: slower ice + stronger ocean feedback.
console.log('\nScan for ice-age oscillation (kIce, Kao):');
let best = null;
for (const kIce of [1/1500, 1/3000, 1/6000]) {
  for (const Kao of [0.002, 0.006, 0.012]) {
    const save = { kIce: P.kIce, Kao: P.Kao }; P.kIce = kIce; P.Kao = Kao;
    const v = balanceV0();
    const aa = analyze(integrate(v, 800000, 20, P.Cref * 1.4, 400, 0.0));
    if (aa.amp > 8 && aa.period) {
      console.log('  kIce=1/'+Math.round(1/kIce), 'Kao='+Kao, '-> amp', aa.amp, 'period ~'+Math.round(aa.period)+'yr', 'V0='+v.toFixed(4));
      if (!best || aa.amp > best.amp) best = { kIce, Kao, v, ...aa };
    }
    P.kIce = save.kIce; P.Kao = save.Kao;
  }
}
if (best) {
  console.log('BEST oscillatory set: kIce=1/'+Math.round(1/best.kIce), 'Kao='+best.Kao, 'period ~'+Math.round(best.period)+'yr amp '+best.amp);
  for (const N of [1500, 3000]) console.log('   co2Speed for ~'+N+'-step cycle =', +(best.period/N).toFixed(2), 'yr/step');
} else {
  console.log('  (no strong limit cycle in scan; system is a stable thermostat — expected for the reduced model)');
}

console.log('\nRecommended defaults:', JSON.stringify({
  co2Ref: P.Cref, co2Tref: P.Tref, co2Sens: P.s,
  volcRate: +V0.toFixed(5), weatherRate: P.W0, weatherTsens: P.kW,
  oceanCO2K: P.Kao, oceanCO2Tsens: P.kH,
  bioRate: P.B0, bioResp: P.R0, bioHalf: P.Chalf, bioCap: P.Kcap, bioOptT: P.Topt, bioTwidth: P.Tw,
}, null, 0));
