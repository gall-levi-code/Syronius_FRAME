# ADR 0012: Gallery Explore aligns photos to attached GPX routes

- **Status:** Accepted
- **Date:** 2026-07-13

## Context

The gallery's publication timestamp records when FRAME processed a photo, not when the camera made
the exposure. Camera capture time is retained in the published EXIF sidecar, while RTIRL GPX track
points use absolute UTC timestamps. A gallery day can also contain more than one streaming session,
gaps caused by RTIRL privacy zones, and photos outside every recorded route.

## Decision

Gallery Admin can attach one or more GPX tracks to an existing published day. The browser parses each
GPX file into timestamped route segments and sends a normalized Explore document to the protected
Gallery API. The Photo Pipeline remains the only writer and atomically stores that document as
`_explore.json` beside the published day.

Public photo records expose the camera's `Photo.DateTimeOriginal` value as `capture_clock`, separately
from `processed_at`. Explore maps a photo by applying the gallery's inferred coarse clock shift and
operator-controlled fine adjustment, then interpolating between adjacent GPX points in the same
segment. It never interpolates across a GPX segment boundary or a tracking gap longer than five
minutes. An operator can override a single photo with a manual latitude, longitude, and raw camera
timestamp without rewriting its photo sidecar. Explore links a manual placement to the next manual
photo when it is closer in time than any GPX point; otherwise it reconnects to the closest aligned
GPX point without changing the imported route.

The public day keeps Photos and Explore as interchangeable views. Explore shows every attached route,
mapped photo markers, and a capture-ordered photo strip. A mapped photo can be opened directly with
`?view=explore&photo=<base>`. Multiple GPX imports are additive and may be removed individually.

Explore data is published under the same access policy as its gallery. Gallery Admin warns operators
that routes expose precise location data and directs RTIRL users to configure privacy zones before
recording near a home or another unsafe location. The map uses Leaflet with normal browser-loaded
OpenStreetMap tiles and visible attribution.

## Consequences

- Gallery processing time no longer needs to approximate camera capture time for map placement.
- Photos outside a route or inside a tracking gap remain unmapped until manually placed.
- Trashing a photo hides its marker but retains its manual placement for restore. Permanent deletion
  removes the matching manual placement; it does not alter the attached routes.
- Raw GPX XML is not needed by the public viewer; it receives only the normalized points required to
  draw paths and interpolate photo positions.
- Public Explore maps require network access to the configured tile service.
