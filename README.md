# WebGL GPU planet-climate engine
3D globe surface, icosahedral dual-hex grid

Four stacked layers (High Air, Low Air, Surface Ocean, Deep Ocean), explicit
time-stepping, finite-volume advection, diagnostic hydrostatic pressure.
Cryosphere
CO₂ cycle + Biosphere

![Geodesic Planet screenshot](screenshot.avif)

`planet/` = browser app + shaders, `harness/` = headless test/bench tooling.

## repository history

TODO: need to pick plans and reports to archive from old branches.

This reconstructs the full development history from flat snapshot
folders (`p.zip`, kept on `main`, see `archive/`):

- `archive/HISTORY.md` — snapshot tree, branch map, aliases, chronology notes
- `archive/RESTORE_PLAN_IMPROVED.md` — reusable method for such reconstructions
- `archive/rebuild_history.py`, `archive/verify_history.py` — the v2 transplant
  scripts (each snapshot tag re-verified against its folder)
- `archive/restore-history-plan.orig.md`, `archive/filelist.orig.txt` — inputs

