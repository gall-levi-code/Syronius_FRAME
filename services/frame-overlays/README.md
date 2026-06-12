# FRAME Overlays

`frame-overlays` provides stable OBS Browser Source URLs and a mobile-friendly preset wizard.

- Wizard: `http://localhost:3733/overlays/setup`
- Stable renderer: `http://localhost:3733/overlays/view/<preset-id>`
- Health: `http://localhost:3733/healthz`

Public renderer pages never receive or visibly render the private SLS stream profile/player ID.
They poll a preset-scoped stats URL, while the service resolves the bound profile internally. The
optional Name field uses the stream profile's friendly description and falls back to the preset
name.

The stock connectivity preset is copied into `/data/state/overlay-presets.json` only when that file
does not exist. Upgrades never replace saved presets. The OBS renderer is intentionally public and
transparent; optional Basic authentication protects the wizard and preset-management API only.

The current renderer supports normalized connectivity telemetry from FRAME SRTLA and connected
BELABOX relay profiles through Stream Management. Upload-progress,
latest-photo, freeform, and scene-bundle renderers remain separate follow-up work.

Connectivity presets support whole-overlay quality opacity, automatic or explicit card width,
safe minimum height, wrapped telemetry block sizing, and user-defined block ordering. The wizard
supports desktop drag ordering plus move buttons for reliable mobile control.
