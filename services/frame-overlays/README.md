# FRAME Overlays V2

`frame-overlays` is one container with three deliberately separate concepts:

- **Templates** are shipped, immutable starting designs. Every registered overlay type has its own default template.
- **Presets** are reusable user-owned layout, theme, and widget configurations. Their overlay type is immutable, and they never contain stream bindings or public URL identity.
- **Sources** bind one preset to one data source and own the permanent OBS Browser Source URL.

Open the wizard at `http://localhost:3733/overlays/setup`. New URLs use
`/overlays/view/<readable-slug>/<random-source-key>`. Every V1
`/overlays/view/<preset-id>` URL is retained through a migration-created legacy alias.

## Runtime behavior

The service stores schema-versioned state at `/data/state/overlay-presets.json`. Mutations are
serialized, validated, revisioned, written through unique temporary files, and preceded by a
latest-state backup. A V1 file is backed up before automatic migration. Management writes require
an `If-Match` header or `expected_revision` and return `409` when another editor wins the race.

Connectivity telemetry is normalized and cached by stream profile. All sources and OBS clients for
the same profile share one non-overlapping upstream poll. Renderers receive telemetry and config
revisions over SSE, reconnect automatically, and use source-scoped REST as a fallback. The old
public `/overlays/stats/:player` proxy now returns `410` so private profile identity is not exposed.

Upload-progress sources use an adapter-aware hub. The first `web_upload` adapter normalizes every
active file into stable transfer identities and fans one shared upstream poll out to all OBS clients.
Aggregate percentages are byte-weighted only when every active transfer reports a total; mixed or
unknown totals use an indeterminate bar. The renderer keeps the oldest active file focused, shows
concurrent receiving/queued counts, and hides unsupported metrics instead of inventing values.

The renderer keeps permanent DOM nodes, chart history, and quality hysteresis through visual-only
preset edits. It treats brief polling errors as transient, computes stale state from sample time,
sizes canvases to their CSS dimensions and device pixel ratio, and remains transparent and
pointer-free for OBS. Nullable metrics remain unavailable through normalization, so feeds such as
BELABOX never render empty telemetry cards or irrelevant chart lines.

The preset editor separates Telemetry from Behavior. Bitrate quality uses a clamped
`warn < good < max` control on a 0–12,000 kbps scale; max drives both the meter and chart. Sampling
runs from 20–2,000 ms and new presets retain 20 samples by default while showing the resulting
visible history duration. The chart labels bitrate and RTT and draws the configured bitrate warning
floor as a dashed guide. RTT uses a matching `good < bad < max` control on a 0–5,000 ms scale;
its max value defines the RTT chart ceiling. When a GOOD overlay is compact, the optional current
bitrate is rendered inside the status bubble instead of opening a separate telemetry card.

The wizard follows a source-first workflow: OBS Sources own URLs and feed bindings, Presets own
reusable designs, and Templates are read-only starting points. Source and preset editors keep a
sticky Save bar visible with explicit saved/unsaved feedback.

## Validation

```sh
npm test
npm run typecheck
npm run build
```
