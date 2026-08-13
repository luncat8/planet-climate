# AGENTS.md

Engineering notes for the Geodesic Planet GPU climate engine.

## Default state / save file

`planet/planet_state.js` is the canonical save. It is a plain JS assignment:

```js
window.PLANET_STATE = { version, level, W, H, simTime, stepCount, params, bounds, A:[8 base64 textures] };
```

It is loaded automatically by `planet/index.html` via a `<script src="planet_state.js">`
tag (before `app.js`), so it works from `file://` with no `fetch`/CORS. On boot,
`app.js` `boot()` applies it when present; an empty `{}`, missing, or broken file
falls back to fresh initial conditions.

## Testing stationary / equilibrium processes

When verifying a stationary process (mean climate, energy balance, parameter
sweep, streamlines, etc.), **load the save file first** so the system is already
in an equilibrated, stable state instead of starting from rest and suffering the
initial transient.

- The bundled `planet_state.js` is already spun up (~1500 simulated days, no NaN).
  Boot the page normally and the state is applied automatically — no wait.
- In a headless harness, read the file as text and run it through the same path
  the app uses:

  ```js
  const txt = fs.readFileSync('planet/planet_state.js', 'utf8');
  const enc = readPlanetStateJS(txt);          // in the engine page context
  planet.applyState(decodePlanetState(enc));   // now in equilibrium
  ```

- Confirm stationarity by stepping a number of times and asserting the field RMS
  is finite and changing only slightly (see `harness/loadsave_test.js`).

- without strong reason do not test L7 detailed grid - slow.

## Regenerating the save

`harness/mksave.js` builds a fresh pre-equilibrated state and writes it to a
`.js` file (round-trips the codec before writing):

```sh
node harness/mksave.js --dir=planet --level=5 --days=20 --out=planet/planet_state.js
```

`harness/loadsave_test.js` validates that a `.js` save loads instantly and keeps
evolving. Run it against any `.js` state:

```sh
node harness/loadsave_test.js --dir=planet --save=planet/planet_state.js
```
