import assert from "node:assert/strict";
import test from "node:test";
import { buildGalleryShareUrls, inferTimeShiftSeconds, matchExplorePhotos, routeSegments, simulatedRouteSegments, splitTrackPoints } from "../public/explore.js";

test("builds canonical gallery and selected Explore share links", () => {
  assert.deepEqual(
    buildGalleryShareUrls("https://frame.test/gallery/2026-07-12/?view=explore&photo=old&utm_source=frame#map", true, "TCL 3846"),
    {
      gallery: "https://frame.test/gallery/2026-07-12/?utm_source=frame&photo=TCL+3846",
      explore: "https://frame.test/gallery/2026-07-12/?utm_source=frame&view=explore&photo=TCL+3846",
      current: "https://frame.test/gallery/2026-07-12/?utm_source=frame&view=explore&photo=TCL+3846",
    },
  );
  assert.deepEqual(
    buildGalleryShareUrls("https://frame.test/gallery/2026-07-12/?view=explore&photo=old", false, "ignored"),
    {
      gallery: "https://frame.test/gallery/2026-07-12/?photo=ignored",
      explore: null,
      current: "https://frame.test/gallery/2026-07-12/?photo=ignored",
    },
  );
  assert.deepEqual(
    buildGalleryShareUrls("https://frame.test/gallery/2026-07-12/", true, "TCL 3846"),
    {
      gallery: "https://frame.test/gallery/2026-07-12/?photo=TCL+3846",
      explore: "https://frame.test/gallery/2026-07-12/?view=explore&photo=TCL+3846",
      current: "https://frame.test/gallery/2026-07-12/?photo=TCL+3846",
    },
  );
  assert.deepEqual(
    buildGalleryShareUrls("https://frame.test/gallery/2026-06-28/", true),
    {
      gallery: "https://frame.test/gallery/2026-06-28/",
      explore: "https://frame.test/gallery/2026-06-28/?view=explore",
      current: "https://frame.test/gallery/2026-06-28/",
    },
  );
});

test("sorts GPX points, removes duplicate timestamps, and splits long tracking gaps", () => {
  const start = Date.parse("2026-07-13T01:00:00Z");
  const segments = splitTrackPoints([
    [start + 760_000, 43, -72],
    [start + 60_000, 41, -74],
    [start, 40, -75],
    [start + 60_000, 99, 99],
    [start + 700_000, 42, -73],
  ]);

  assert.deepEqual(segments, [
    [[start, 40, -75], [start + 60_000, 41, -74]],
    [[start + 700_000, 42, -73], [start + 760_000, 43, -72]],
  ]);
});

test("matches capture clocks and chains manual placements until a GPX timestamp is closer", () => {
  const trackStart = Date.parse("2026-07-13T01:00:00Z");
  const routes = [{ segments: [
    [[trackStart, 40, -75], [trackStart + 60_000, 41, -74]],
    [[trackStart + 600_000, 42, -73], [trackStart + 660_000, 43, -72]],
  ] }];
  const photos = [
    { base: "start", capture_clock: "2026:07:12 20:00:00" },
    { base: "auto", capture_clock: "2026:07:12 20:00:30" },
    { base: "gap", capture_clock: "2026:07:12 20:05:00" },
    { base: "manual", capture_clock: null },
    { base: "legacy", capture_clock: "2026:07:12 20:00:50" },
    { base: "end", capture_clock: "2026:07:12 20:01:00" },
  ];
  const explore = {
    routes,
    time_shift_seconds: inferTimeShiftSeconds(photos, routes),
    time_adjustment_seconds: 0,
    placements: {
      manual: { lat: 39.5, lon: -76.5, timestamp: Date.parse("2026-07-12T20:00:40Z") },
      legacy: { lat: 39.6, lon: -76.4 },
    },
  };

  assert.equal(explore.time_shift_seconds, 5 * 3600);
  assert.equal(routeSegments(explore).length, 2);
  const matches = matchExplorePhotos(photos, explore);
  assert.deepEqual({ lat: matches.get("auto").lat, lon: matches.get("auto").lon, source: matches.get("auto").source }, { lat: 40.5, lon: -74.5, source: "track" });
  assert.equal(matches.has("gap"), false);
  assert.deepEqual({ lat: matches.get("manual").lat, lon: matches.get("manual").lon, source: matches.get("manual").source }, { lat: 39.5, lon: -76.5, source: "manual" });
  assert.equal(matches.get("manual").time, trackStart + 40_000);
  assert.equal(matches.get("legacy").time, trackStart + 50_000);
  assert.deepEqual(simulatedRouteSegments(photos, explore), [
    [[trackStart + 40_000, 39.5, -76.5], [trackStart + 50_000, 39.6, -76.4]],
    [[trackStart + 50_000, 39.6, -76.4], [trackStart + 60_000, 41, -74]],
  ]);
});
