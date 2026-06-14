# FRAME Photo Gallery

The public presentation layer for published FRAME photos. The service lists only images with a
final `.ready` manifest and no `.trashed.json` marker, and generates cached WebP thumbnails under
`/data/gallery-cache`.

Open `/today/gallery` for the multi-day album index or `/today/gallery/YYYY-MM-DD/` for one
published day. `/gallery` remains a compatible alias. Open the shared-login-protected
`/today/gallery/admin` page to trash, restore, or permanently delete photos and albums. Gallery
Admin proxies mutations to the Photo Pipeline; it does not write publications directly.

The gallery is FRAME-owned rather than bundled SFPG because SFPG's official EULA prohibits
redistributing it as part of another work. See
[`ADR 0008`](../../docs/adr/0008-frame-owned-photo-gallery.md).
