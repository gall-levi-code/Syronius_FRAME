# FRAME Photo Upload

FRAME Photo Upload lets trusted users send photos into FRAME from a phone, tablet, or browser.
Uploaded photos are queued for processing, then handed to the FRAME photo workflow.

## Who This Is For

FRAME Photo Upload is for event helpers, stream staff, and operators who need a simple browser
upload page.

Use it if you want to:

- Upload photos from a phone or computer.
- Drag and drop multiple photos from a browser.
- Let trusted people upload photos from outside your local network.
- Watch per-file upload progress.
- Queue photos for the FRAME gallery and Photo Stage.
- Avoid setting up camera FTP.

## What You Use It For

Use Photo Upload when people need an easy way to send photos into FRAME.

Common uses:

- Let staff upload event photos from mobile devices.
- Let trusted remote helpers send photos through FRAME Tunnel.
- Add screenshots, phone photos, or edited images to the FRAME photo workflow.
- Queue several files at once and see which ones were accepted.
- Feed live upload-progress overlays and status views through the shared photo journey.

Photo Upload does not decide which images become public. It safely receives the files, then the
Photo Pipeline validates, converts, and publishes them.

## How To Install

Photo Upload is part of the normal FRAME stack.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd`.
3. Choose **Guided setup**.
4. Enable **Browser Photo Upload**.
5. Enable **FRAME Tunnel** if trusted people need to upload from outside your local network.
6. Enable the photo workflow tools you want, such as Photo Gallery and Photo Stage.
7. Start the stack.
8. Open Photo Upload:

```text
http://localhost/photos/upload
```

Most users should run Photo Upload through the full FRAME stack.

## How To Operate

Open locally:

```text
http://localhost/photos/upload
```

For outside access, use your FRAME Tunnel public address after Hybrid/public access is configured.

To upload photos:

1. Log in if FRAME asks for the Portal login.
2. Select photos, or drag photos onto the upload page.
3. Check the listed files before sending.
4. Start the upload.
5. Wait for each file to show accepted or failed.
6. Open the Gallery or Photo Stage after processing finishes.

The upload page shows the current file and session limits. Large files or too many selected files
may be rejected depending on your FRAME settings.

If an upload fails:

1. Try fewer files at once.
2. Check that the device still has a strong network connection.
3. Try again from Chrome, Edge, or Safari.
4. Ask the FRAME operator to check Portal logs if the page keeps failing.

## Relies Upon

Photo Upload relies on:

- FRAME Portal
- FRAME Edge
- FRAME Auth when login is enabled
- FRAME Photo Pipeline
- FRAME shared data storage

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Outside-network uploads | FRAME Tunnel |
| Published gallery photos | FRAME Photo Gallery |
| Photo Stage viewer and remote | FRAME Photo Stage |
| Upload-progress overlays | FRAME Overlays |

## Notes For Operators

Photo Upload writes completed uploads into the shared FRAME photo staging flow.

Each accepted file receives a durable journey ID. FRAME uses that ID to correlate browser receipt,
pipeline processing, publication, retries, and the upload-progress overlay without treating the same
photo as several unrelated transfers.

The Photo Pipeline remains responsible for validating files, converting images, updating gallery
data, and rejecting unsupported uploads.

Use FRAME Tunnel when trusted uploaders need access from outside your LAN, and keep the upload page
login-protected.
