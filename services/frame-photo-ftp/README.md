# FRAME Photo FTP

FRAME Photo FTP lets cameras send photos directly into FRAME over FTP. It is meant for experienced
users who are comfortable configuring camera FTP settings, router port forwarding, and firewall
rules.

## Who This Is For

FRAME Photo FTP is for operators using cameras with built-in FTP upload support.

Use it if you want to:

- Send photos straight from a camera to FRAME.
- Let a camera upload from outside your local network using forwarded ports.
- Queue camera photos for the FRAME gallery and Photo Stage.
- Avoid manually copying camera files after an event.

If you want the simpler external upload path, use FRAME Photo Upload with FRAME Tunnel instead.

## What You Use It For

Use Photo FTP when a camera should automatically send finished photos into FRAME.

Common uses:

- Event cameras sending photos to the FRAME computer.
- Remote cameras uploading through router port forwarding.
- Photo workflows where a camera operator keeps shooting while FRAME processes in the background.

Photo FTP does not publish photos by itself. It receives completed camera uploads, then the Photo
Pipeline validates, converts, and publishes them.

## How To Install

Photo FTP is part of the normal FRAME stack.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd`.
3. Choose **Guided setup**.
4. Enable **Camera FTP Upload**.
5. Enable the photo workflow tools you want, such as Photo Gallery and Photo Stage.
6. Set an FTP username and password.
7. Set the FTP passive host to the address the camera will use.
8. Start the stack.

For local cameras, the passive host is usually the FRAME computer's LAN IP address.

For external cameras, the passive host is usually your public IP address or public DNS name. You
must also forward the FTP port and passive port range from your router to the FRAME computer.

## How To Operate

In your camera's FTP settings, use:

| Setting | Use |
| --- | --- |
| Server | FRAME LAN IP, public IP, or public DNS name |
| Protocol | FTP |
| Port | `2121` unless changed in FRAME settings |
| Username | The FTP username from FRAME setup |
| Password | The FTP password from FRAME setup |
| Passive mode | Enabled |
| Target folder | Root folder, unless your camera requires a folder |

For external uploads, forward these to the FRAME computer:

- The FTP control port
- The full passive port range

After upload, FRAME waits until the file is finished before handing it to the Photo Pipeline.

## Relies Upon

Photo FTP relies on:

- FRAME shared data storage
- FRAME Photo Pipeline
- A camera or device that supports FTP upload
- Local firewall access
- Router port forwarding for external camera uploads

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Published gallery photos | FRAME Photo Gallery |
| Photo Stage viewer and remote | FRAME Photo Stage |
| Upload-progress overlays | FRAME Overlays, when FTP progress support is added |

## Notes For Operators

This tool is for experienced users. Incorrect port forwarding can expose your FTP service to the
public internet.

Use a strong FTP password. If your camera and network support encrypted FTP, prefer that for
external uploads.

For less technical uploaders, use FRAME Photo Upload with FRAME Tunnel instead.
