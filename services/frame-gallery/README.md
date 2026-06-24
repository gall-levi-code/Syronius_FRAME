# FRAME Photo Gallery

The public presentation layer for published FRAME photos. The service lists only images with a
final `.ready` manifest and no `.trashed.json` marker, and generates cached WebP thumbnails under
`/data/gallery-cache`.

Open `/today/gallery` for the multi-day album index or `/today/gallery/YYYY-MM-DD/` for one
published day. `/gallery` remains a compatible alias. Open the shared-login-protected
`/today/gallery/admin` page to trash, restore, permanently delete photos and albums, or customize
the public gallery branding. Gallery Admin proxies photo mutations to the Photo Pipeline; it does
not write publications directly.

Branding settings are stored in `DATA_ROOT/gallery-branding/config.json`. Uploaded logos are
normalized to WebP under `DATA_ROOT/gallery-branding/logo.webp`, capped at 360 by 120 pixels for
display, and served through `/gallery/branding/logo.webp`. The public gallery reads
`/gallery/api/branding` and supports five built-in style presets, saved custom presets, generated
color-based themes, fully custom day/night palettes, and a visitor day/night toggle.

The gallery is FRAME-owned rather than bundled SFPG because SFPG's official EULA prohibits
redistributing it as part of another work. See
[`ADR 0008`](../../docs/adr/0008-frame-owned-photo-gallery.md).
