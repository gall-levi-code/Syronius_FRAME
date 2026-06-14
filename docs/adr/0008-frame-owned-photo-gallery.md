# ADR 0008: FRAME-Owned Photo Gallery

- Status: Accepted
- Date: 2026-06-13

## Context

The V1 specification selected Single File PHP Gallery (SFPG) for gallery presentation and thumbnail
generation. SFPG's official EULA permits private non-commercial use but prohibits distributing the
script or including it in another distributed work. Bundling it inside the FRAME repository or
container would conflict with that restriction.

## Decision

FRAME provides its own read-only `frame-gallery` service.

- Only publications with a final `.ready` manifest are visible.
- The service reads images and sidecars from `/data/galleries/YYYY-MM-DD`.
- Generated WebP thumbnails are stored separately under `/data/gallery-cache`.
- Gallery media routes validate date folders and published base names before serving files.
- `/gallery` and `/today/gallery` are safe public presentation aliases for optional Hybrid exposure.
- `/today/gallery/admin` is protected by shared FRAME authentication and proxies management
  requests to the Photo Pipeline.
- `/today/gallery` is the multi-day album index and `/today/gallery/YYYY-MM-DD/` is a published day.
- The OBS viewer and authenticated remote controls remain responsibilities of `frame-today`.

## Consequences

- FRAME can be distributed without depending on SFPG's restrictive redistribution terms.
- The pipeline remains the only publication mutation authority; the Gallery Admin cannot mutate
  published originals directly.
- Thumbnail paths differ from the earlier SFPG-specific draft and consumers must use the gallery
  thumbnail route rather than assuming a `.thumbs` folder.
- Direct gallery routes avoid the duplicated headers and navigation problems of an iframe wrapper.
