# FRAME Photo Gallery

FRAME Photo Gallery shows the photos that FRAME has accepted and published. It gives viewers a
clean album page with an optional route map, and gives operators a protected admin page for hiding,
restoring, deleting, branding, and mapping gallery photos.

## Who This Is For

FRAME Photo Gallery is for viewers, stream staff, and operators who want to browse or manage
published FRAME photos.

Use it if you want to:

- Show a public gallery of event or stream photos.
- Browse photos by day.
- Share a gallery link with viewers.
- Attach one or more RTIRL GPX routes to a gallery day.
- Explore a day's route and jump between mapped photos.
- Hide or restore photos from the gallery.
- Permanently delete published gallery copies when needed.
- Choose each album's gallery cover.
- Customize gallery branding, logo, social links, and visitor download controls.

## What You Use It For

Use Photo Gallery as the public photo album for FRAME.

Common uses:

- Let viewers browse published photos.
- Review photos after browser upload or camera FTP upload.
- Remove unwanted photos from public view.
- Restore photos that were hidden by mistake.
- Match the gallery branding to your stream, event, or production.
- Add ordered social/profile links with platform icons and optional custom graphics.
- Control whether visitors can view and download the full gallery JPEG.
- Correct camera-to-GPX clock differences and manually place unmatched photos.

Photo Gallery does not receive uploads directly. Photos come from Photo Upload or Photo FTP, then
the Photo Pipeline processes and publishes them.

## How To Install

Photo Gallery is part of the normal FRAME stack.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd`.
3. Choose **Guided setup**.
4. Enable **Photo Gallery**.
5. Enable at least one photo input, such as **Browser Photo Upload** or **Camera FTP Upload**.
6. Enable **Photo Pipeline** if it is not already selected automatically.
7. Start the stack.
8. Open the gallery:

```text
http://localhost/today/gallery
```

For public viewing outside your local network, use FRAME Tunnel or your configured public FRAME
address.

## How To Operate

Open the public gallery:

```text
http://localhost/today/gallery
```

Open the protected admin page:

```text
http://localhost/today/gallery/admin
```

On the public gallery, viewers can:

- Browse available photo days.
- Open one day's album.
- Scroll through large albums while FRAME loads photo metadata in small batches.
- View photos through page-bound tiles when downloads are disabled, or the full gallery JPEG when downloads are enabled.
- Switch between Photos and Explore when a day has attached route data.
- Select a mapped photo from its thumbnail, lightbox, map marker, or Explore photo strip.
- Open the configured social/profile links from the gallery header.
- Switch day/night mode when enabled.

On the admin page, operators can:

- Move photos or albums to trash.
- Restore trashed photos or albums.
- Permanently delete trashed gallery copies.
- Empty the gallery trash.
- Add or remove multiple GPX sessions for one day.
- Adjust camera-to-GPX timing and manually place photos that do not match a route.
- Choose or clear a custom cover for each album.
- Change the gallery title, brand name, and logo.
- Add, reorder, label, and optionally illustrate social/profile links.
- Enable or disable full gallery JPEG downloads for every public gallery.

Trash is reversible. Permanent delete is not.

Saving Explore publishes its route and mapped photo locations immediately to everyone who can view
that gallery. Routes contain precise location data. Configure RTIRL privacy zones so tracking is
disabled near your home or any other unsafe location, and review the map before saving. Long tracking
gaps are drawn as separate route segments rather than connected by a straight line.

## Relies Upon

Photo Gallery relies on:

- FRAME Portal
- FRAME Edge
- FRAME Auth for the admin page
- FRAME Photo Pipeline
- FRAME shared data storage

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Browser photo uploads | FRAME Photo Upload |
| Camera FTP uploads | FRAME Photo FTP |
| Photo Stage viewer and remote | FRAME Photo Stage |
| Public gallery access | FRAME Tunnel or configured public FRAME access |
| Explore map tiles | Internet access to the configured OpenStreetMap tile service |

## Notes For Operators

The public gallery can be shared with viewers when your FRAME access rules allow it.

The admin page should stay login-protected.

Photo Gallery asks Photo Pipeline to hide, restore, or delete photos and albums. It does not edit the
published photo files directly.

Photo Gallery keeps a rebuildable SQLite catalog in `gallery-cache/gallery-catalog.sqlite`. The
catalog stores public photo metadata and per-gallery summaries so normal page requests do not parse
every sidecar. Published files remain authoritative: FRAME reconciles new, trashed, restored, and
deleted files automatically, and recreates the catalog if it is missing or unreadable. Gallery-owner
settings are stored separately and are not lost when the catalog is rebuilt.

The visitor photo grid requests 60 records at a time and loads more as the viewer scrolls. Gallery
Admin keeps using the complete list, while Explore loads the complete day's metadata only when its
map needs it.

Thumbnail and tile caches remain disposable. A newly generated tile set removes older versions for
that photo, and permanent photo deletion clears its thumbnail and tile cache. Cache pruning itself
never touches published or archived source files.

When downloads are disabled, public lightbox photos are delivered as short-lived, page-bound tiles and
FRAME does not expose a public full-image route. When downloads are enabled, the lightbox and Download
action use the full normalized gallery JPEG; the archived camera file remains private. Tiles can still
be captured or reassembled by a determined visitor, and anything visible in a browser can be
screenshotted; this is download deterrence and archive-file protection, not image DRM.

Explore uses the camera capture clock retained in the photo sidecar, not the time FRAME processed the
photo. If the camera clock and GPX clock differ, Gallery Admin can infer the coarse timezone shift and
apply a fine seconds adjustment. Manual photo placements survive trash and restore; permanent photo
deletion removes the matching placement but leaves the day's routes intact.
