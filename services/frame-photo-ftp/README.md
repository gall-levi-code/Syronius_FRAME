# FRAME Photo FTP

A camera-friendly Pure-FTPd input with a required completion gate. Camera uploads land in `/data/inbox`.
When a file's size and modification time remain unchanged for three seconds, it moves atomically to
`/data/staging` for the Photo Pipeline.

The FTP service is LAN-only. Configure `PHOTO_FTP_PASSIVE_HOST` to the FRAME host's LAN address and
open the configured FTP and passive port range on the host firewall.

## Connection flow and ports

1. A camera connects to `PHOTO_FTP_PORT` (`2121/tcp` by default), authenticates, and keeps that
   control connection open for FTP commands.
2. For each directory listing or upload, Pure-FTPd selects one temporary passive data port from
   `PHOTO_FTP_PASSIVE_MIN` through `PHOTO_FTP_PASSIVE_MAX` (`30000-30009/tcp` by default).
3. Completed bytes land in `/data/inbox`. The FRAME stability gate checks the file every
   `PHOTO_FTP_SCAN_MS` and atomically moves it to `/data/staging` after its size and modification
   time remain unchanged for `PHOTO_FTP_STABLE_MS`.
4. The Photo Pipeline claims the staged file, validates and normalizes it, then publishes the
   gallery image and sidecars.

`3737/tcp` is the container's internal health/status endpoint. Compose does not publish it to the
host. The ten-port passive range permits several simultaneous data operations without exposing a
large arbitrary port range.

`PHOTO_FTP_PASSIVE_HOST` must be an address the camera can reach. `127.0.0.1` works only for an FTP
client running on the FRAME host itself; LAN cameras should use the FRAME host's stable LAN IP.
