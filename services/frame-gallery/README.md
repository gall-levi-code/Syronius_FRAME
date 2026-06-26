# FRAME Photo Gallery

FRAME Photo Gallery shows the photos that FRAME has accepted and published. It gives viewers a
clean album page, and gives operators a protected admin page for hiding, restoring, deleting, and
branding gallery photos.

## Who This Is For

FRAME Photo Gallery is for viewers, stream staff, and operators who want to browse or manage
published FRAME photos.

Use it if you want to:

- Show a public gallery of event or stream photos.
- Browse photos by day.
- Share a gallery link with viewers.
- Hide or restore photos from the gallery.
- Permanently delete published gallery copies when needed.
- Customize gallery branding, colors, and logo.

## What You Use It For

Use Photo Gallery as the public photo album for FRAME.

Common uses:

- Let viewers browse published photos.
- Review photos after browser upload or camera FTP upload.
- Remove unwanted photos from public view.
- Restore photos that were hidden by mistake.
- Match the gallery branding to your stream, event, or production.

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
- View photos in the selected style.
- Switch day/night mode when enabled.

On the admin page, operators can:

- Move photos or albums to trash.
- Restore trashed photos or albums.
- Permanently delete trashed gallery copies.
- Empty the gallery trash.
- Change the gallery title, brand name, logo, and colors.
- Save custom gallery styles.

Trash is reversible. Permanent delete is not.

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
| Today viewer and remote | FRAME Today |
| Public gallery access | FRAME Tunnel or configured public FRAME access |

## Notes For Operators

The public gallery can be shared with viewers when your FRAME access rules allow it.

The admin page should stay login-protected.

Photo Gallery asks Photo Pipeline to hide, restore, or delete photos. It does not edit the published
photo files directly.
