# OpenIRL SRTLA patches on SRT 1.5.6

`openirl-srtla-v1.5.6.patch` is the OpenIRL standalone-receiver patch set replayed on Haivision SRT
v1.5.6 (`c63c311e88aa55e430e3b7d94b89d790994f88c4`).

It preserves these OpenIRL commits:

- `3ba7db2` — fixed SRTLA reordering tolerance
- `8adf9f6` — suppress premature periodic NAKs
- `4c26db9` — add `SRTO_SRTLAPATCHES`
- `58f5f2c` — add per-link SRTLA statistics
- `7f858ae` — add total per-link throughput
- `b9433b3` — restore periodic NAK reporting
- `d46a904` — exclude losses still inside the reordering window

The only merge resolution retains both SRT 1.5.6 packet-size initialization and OpenIRL's SRTLA
statistics initialization in the `CUDT` constructor.

This deliberately excludes OpenIRL commit `15a2ea3`, which replaces the standalone receiver with an
in-library SRTLA demultiplexer and changes the socket API expected by receiver 1.2.0.
