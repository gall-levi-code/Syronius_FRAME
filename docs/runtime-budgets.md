# Runtime budgets and log retention

FRAME applies the same logging policy to all 17 Compose services. Each uses Docker's
`local` driver, retaining three files of up to 10 MiB each and compressing rotated files.
This is roughly 30 MiB per container before compression, or 480 MiB for the 16 services
enabled on this installation. Docker and Portal log viewing continue to use the Docker
API. Docker manages these files; applications should not edit them directly.
[Docker local logging documentation](https://docs.docker.com/engine/logging/drivers/local/)

BELABOX command auditing is separate from container output. It retains the current
`command-audit.jsonl` plus three numbered archives, rotating at 4 MiB, with owner-only
file permissions. The manager loads the latest 200 valid records using bounded reads;
the existing API continues to expose the latest 100. Export older audit records before
the finite retention window expires if longer history is required.
An oversized log from an older installation is preserved whole when first archived;
it ages out through normal rotation rather than being truncated during upgrade.

## Resource defaults

These defaults protect the host from runaway control services while allowing media
workers to handle their supported workloads. They are initial engineering allowances,
not measured peak requirements. CPU quotas are not applied.

| Services | Memory reservation | Memory limit | PID/thread limit |
| --- | ---: | ---: | ---: |
| Auth, Portal, Edge, Docker Proxy, Public Gateway, Tunnel, Overlays, Streams, Today, Photo Upload, Photo FTP | 64 MiB each | 512 MiB each | 256 each |
| BELABOX Manager | 128 MiB | 1,024 MiB | 256 |
| Photo Pipeline | 1,024 MiB | Unset | Unset |
| Photo Gallery, Video Ingest, Audio Bridge | 256 MiB each | Unset | Unset |
| Audio Monitor | 128 MiB | Unset | Unset |

Reservations are soft settings under memory pressure; they do not preallocate RAM or
cap usage. Memory limits are enforced, and exceeding them can terminate a container.
PID limits also count kernel threads. These are ordinary Compose service settings and
apply without Swarm.
[Compose resource settings](https://docs.docker.com/reference/compose-file/services/#mem_limit),
[Docker memory constraints](https://docs.docker.com/engine/containers/resource_constraints/#limit-a-containers-access-to-memory)

The September 8, 2026 idle snapshot measured 543.62 MiB across the 16 running FRAME
containers on a Docker Desktop VM with 15.57 GiB and 16 CPUs. Individual control
services used approximately 15–92 MiB. Active media load was absent. Phase 2's isolated
50 MiB photo transfer measured sampled process RSS peaks of 124.8 MiB for the manager
and 71.7 MiB for the receiver; these also do not establish maximum simultaneous load.

Media caps need a representative peak-load test first. The pipeline supports two
80-megapixel images by default: two RGBA buffers alone would require roughly 610 MiB,
before decoding and conversion overhead. Gallery processing uses Sharp, Audio Monitor
spawns FFmpeg per source, and video/Discord allocations depend on simultaneous streams
and listeners. Idle measurements cannot establish safe limits for those workloads.

## Adjusting control limits

The CLI and native installers preserve these advanced settings across reinstall:

| Setting | Default | Accepted range |
| --- | ---: | ---: |
| `FRAME_CONTROL_MEMORY_MB` | 512 | 128–65,536 MiB |
| `FRAME_BELABOX_MEMORY_MB` | 1,024 | 128–65,536 MiB |
| `FRAME_CONTROL_PIDS` | 256 | 64–65,536 |

For example, on Windows:

```powershell
.\stack.cmd install --set FRAME_CONTROL_MEMORY_MB=768 --set FRAME_BELABOX_MEMORY_MB=1536 --set FRAME_CONTROL_PIDS=512
```

On Linux, use `./stack.sh install` with the same arguments. Increasing these values
does not allocate that much RAM immediately. The memory setting applies to each listed
control service, not to their combined total.

Use `docker compose stats --no-stream` to observe current usage and inspect
`State.OOMKilled`, `RestartCount`, and `HostConfig` with `docker inspect` when diagnosing
restarts. A container must be recreated to pick up Compose logging/resource changes;
a plain restart retains its old configuration. Schedule recreation while publishers,
FTP sessions, uploads, and image processing are idle.

Storage measurements and the repeatable scratch-only comparison are documented in
[Storage benchmark](storage-benchmark.md). Storage migration requires a separate
backup, downtime, path, and recovery plan.
