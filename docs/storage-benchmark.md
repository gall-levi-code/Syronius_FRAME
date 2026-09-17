# FRAME storage benchmark

The September 8, 2026 measurement found that Docker's named volume handled the synthetic gallery
scan, streamed copy, and renames faster than the current Windows bind mount. The bind mount was
faster for the explicit `fsync` workload. This is evidence for choosing storage by workload, not a
promise that moving FRAME's data would produce the same application speedup.

## Run it again

From the repository root, with Docker running and the Node 22 image already available locally:

```powershell
node scripts/storage-benchmark.mjs --self-test
node scripts/storage-benchmark.mjs --output storage-benchmark-results.json
```

`--container` defaults to `frame-pipeline-photos`; the script discovers that container's `/data`
bind source through Docker inspect. `--image` defaults to `node:22.23.2-alpine`. It resolves the image
to one immutable image ID and uses that same image for both measurements, with image pulling
disabled. The worker verifies that it is running Node 22. Omit `--output` to print JSON without
saving it; when supplied, the output filename must be new so an earlier result is not overwritten.

The self-check uses a small temporary host directory. It exercises the real benchmark operations,
checks their results and cleanup, and verifies that cleanup refuses the wrong ownership token.
It requires no Docker container.

## Scope and safety

Only synthetic files are used. The script creates a unique `.frame-storage-bench-<UUID>` directory
inside the discovered data root and mounts only that scratch directory into a temporary container.
It never enumerates or reads user photo directories. It removes the bind scratch data before
populating a separately created, uniquely named Docker volume, keeping live generated file contents
below 101 MiB. Filesystem allocation and metadata overhead are separate from that payload limit.

Both workers have a read-only container root, no network, and the same 512 MiB memory limit. The
script checks the scratch directory's resolved parent, name, and ownership marker before recursive
cleanup. Volume removal checks its exact name and unique ownership label; temporary container
cleanup likewise checks the label and exact name. No live service is restarted, and no storage is
migrated. The scratch identifiers are printed before measurement, so resources can be identified
if the process is forcibly interrupted or Docker becomes unavailable before cleanup.

## Measured operations

Each backend runs one untimed warmup and three measured runs. The report contains every measured
run and the per-operation median:

| Operation | Work performed in each measured run |
| --- | --- |
| Gallery scan | Enumerate 10 synthetic albums containing 1,000 photos / 3,000 metadata files. For each photo, read and parse its JSON, stat its ready marker, and read its camera text, using 32 concurrent workers. |
| Copy and hash | Stream a synthetic 50 MiB file through SHA-256 into another file; check the digest and output size. The timing includes file close, but does not call `fsync`. |
| Atomic rename | Perform 500 sequential same-directory renames of one file between two names. Directory entries are not explicitly synced. |
| Synced write | Perform 32 sequential 4 KiB writes, each with open, write, `fsync`, and close. |

## September 8 results

The bind source was `E:\FRAME_DATA`, accessed from Linux containers through Docker Desktop's WSL2
backend. Both workers ran Node **22.23.2** from the same image ID recorded in the
[raw result](storage-benchmark-results-2026-09-08.json).

| Operation | Windows bind median | Named volume median | Observation |
| --- | ---: | ---: | --- |
| Gallery scan | 982.42 ms | 356.27 ms | Named volume completed in 36% of the bind time. |
| 50 MiB copy + SHA-256 | 562.45 ms | 157.64 ms | Named volume completed in 28% of the bind time. |
| 500 atomic renames | 907.40 ms | 49.12 ms | Named volume completed in 5.4% of the bind time. |
| 32 synced 4 KiB writes | 119.48 ms | 261.40 ms | Named volume took 2.19 times as long. |

These are **warm-cache, synthetic end-to-end filesystem timings**. Dataset creation and warmup
prime caches; the script does not flush Windows, Linux, or device caches. The comparison includes
the Windows-to-Linux file-sharing path, Docker's volume backend, filesystem behavior, and concurrent
host activity. It does not isolate physical drive throughput or identify one cause for the
difference. The two backends run sequentially, with the bind mount first.

The `fsync` result measures completion latency through each backend; it does not establish equal
power-loss durability. The copy result includes hashing and cached I/O, so it is not a raw disk
bandwidth test. Real FRAME workloads also include image decoding, HTTP, application caches, and
different file counts. Repeat the benchmark on the target installation before making a storage
decision, and validate application behavior before considering a migration.

The benchmark self-check passed. After this recorded run, the exact scratch directory was absent
and Docker reported no remaining volume or container with its unique ownership label.
