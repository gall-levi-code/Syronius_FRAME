# FRAME Today

OBS-focused photo presentation for the current FRAME photo day.

- `/today/` opens the latest published day's gallery.
- `/today/gallery` is served directly by FRAME Gallery as the multi-day album index.
- `/today/viewer` is a fullscreen OBS browser source with live camera/EXIF information.
- `/today/remote` is an authenticated mobile controller for navigation, slideshow timing, and EXIF visibility.

The remote exposes explicit Play, Pause, and Stop states. Stop returns to the newest publication.
When playback is paused or stopped, **Scroll image once** presents the current photo at full width,
holds at the top for one second, scrolls from top to bottom over five seconds with eased starts and
stops, holds at the bottom for one second, and restores the normal fit view. Navigation or resumed
playback cancels the effect immediately.

The service reads published day folders and `state/latest.json` read-only. It never mutates pipeline
publications. Camera information is limited to useful camera and exposure fields; GPS/location
metadata is not persisted or displayed.
