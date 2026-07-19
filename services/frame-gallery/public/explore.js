export function routeSegments(explore) {
  const routes = Array.isArray(explore) ? explore : explore?.routes;
  return (routes || []).flatMap((route) => Array.isArray(route?.segments) ? route.segments : []);
}

export function splitTrackPoints(points, gapMs = 5 * 60 * 1_000) {
  const sorted = [...(points || [])].sort((left, right) => left[0] - right[0]);
  const unique = sorted.filter((point, index) => index === 0 || point[0] !== sorted[index - 1][0]);
  const segments = [];
  let current = [];
  for (const point of unique) {
    if (current.length && point[0] - current.at(-1)[0] > gapMs) {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

export function inferTimeShiftSeconds(photos, routes) {
  const captures = (photos || []).map((photo) => captureTimestamp(photo?.capture_clock)).filter(Number.isFinite);
  const ranges = routeSegments(routes).map((segment) => [segment?.[0]?.[0], segment?.at(-1)?.[0]])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end));
  if (!captures.length || !ranges.length) return 0;

  let bestShift = 0;
  let bestScore = -1;
  for (let shift = -14 * 3600; shift <= 14 * 3600; shift += 15 * 60) {
    const score = captures.reduce((total, capture) => total + Number(ranges.some(([start, end]) => capture + shift * 1000 >= start && capture + shift * 1000 <= end)), 0);
    if (score > bestScore || (score === bestScore && Math.abs(shift) < Math.abs(bestShift))) {
      bestShift = shift;
      bestScore = score;
    }
  }
  return bestShift;
}

export function matchExplorePhotos(photos, explore) {
  const matches = new Map();
  const segments = routeSegments(explore);
  const shift = (Number(explore?.time_shift_seconds) || 0) + (Number(explore?.time_adjustment_seconds) || 0);

  for (const photo of photos || []) {
    if (!photo?.base) continue;
    const placement = explore?.placements?.[photo.base];
    if (validCoordinate(placement?.lat, placement?.lon)) {
      const capture = Number.isInteger(placement.timestamp) ? placement.timestamp : captureTimestamp(photo.capture_clock);
      matches.set(photo.base, {
        lat: placement.lat,
        lon: placement.lon,
        source: "manual",
        photo,
        ...(Number.isFinite(capture) ? { time: capture + shift * 1000 } : {}),
      });
      continue;
    }

    const capture = captureTimestamp(photo.capture_clock);
    if (!Number.isFinite(capture)) continue;
    const point = interpolateAt(capture + shift * 1000, segments);
    if (point) matches.set(photo.base, { ...point, source: "track", photo });
  }
  return matches;
}

export function simulatedRouteSegments(photos, explore) {
  const points = routeSegments(explore).flat()
    .filter((point) => Number.isFinite(point?.[0]) && validCoordinate(point?.[1], point?.[2]))
    .sort((left, right) => left[0] - right[0]);
  if (!points.length) return [];
  const matches = matchExplorePhotos(photos, explore);
  const manuals = (photos || [])
    .map((photo, index) => ({ index, match: matches.get(photo?.base) }))
    .filter(({ match }) => match?.source === "manual" && Number.isFinite(match.time))
    .sort((left, right) => left.match.time - right.match.time || left.index - right.index);
  const segments = [];
  for (let index = 0; index < manuals.length; index += 1) {
    const manual = manuals[index].match;
    const nextManual = manuals[index + 1]?.match;
    const point = closestTimedPoint(manual.time, points);
    const target = nextManual && nextManual.time - manual.time <= Math.abs(point[0] - manual.time)
      ? [nextManual.time, nextManual.lat, nextManual.lon]
      : [point[0], point[1], point[2]];
    segments.push([
      [manual.time, manual.lat, manual.lon],
      target,
    ]);
  }
  return segments;
}

function closestTimedPoint(time, points) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle][0] < time) low = middle + 1;
    else high = middle;
  }
  const before = points[low - 1];
  const after = points[low];
  if (!before) return after;
  if (!after) return before;
  return time - before[0] <= after[0] - time ? before : after;
}

function interpolateAt(time, segments) {
  for (const segment of segments) {
    if (!Array.isArray(segment) || !segment.length || time < segment[0]?.[0] || time > segment.at(-1)?.[0]) continue;
    if (segment.length === 1) {
      const [pointTime, lat, lon] = segment[0];
      return time === pointTime && validCoordinate(lat, lon) ? { lat, lon, time } : null;
    }

    let low = 0;
    let high = segment.length - 1;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (segment[middle][0] <= time) low = middle;
      else high = middle;
    }
    const [startTime, startLat, startLon] = segment[low];
    const [endTime, endLat, endLon] = segment[high];
    if (![startTime, startLat, startLon, endTime, endLat, endLon].every(Number.isFinite)) return null;
    const ratio = endTime === startTime ? 0 : (time - startTime) / (endTime - startTime);
    return {
      lat: startLat + (endLat - startLat) * ratio,
      lon: startLon + (endLon - startLon) * ratio,
      time,
    };
  }
  return null;
}

export function captureTimestamp(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  const exif = value.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (exif) {
    const [, year, month, day, hour, minute, second, fraction = ""] = exif;
    return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second, +(fraction.padEnd(3, "0").slice(0, 3)));
  }
  return Date.parse(value);
}

export function buildGalleryShareUrls(href, exploreAvailable, selectedBase = null) {
  const gallery = new URL(href);
  const exploreRequested = gallery.searchParams.get("view") === "explore";
  gallery.searchParams.delete("view");
  gallery.searchParams.delete("photo");
  if (selectedBase) gallery.searchParams.set("photo", selectedBase);
  gallery.hash = "";
  const galleryUrl = gallery.toString();
  if (!exploreAvailable) return { gallery: galleryUrl, explore: null, current: galleryUrl };

  const explore = new URL(gallery);
  explore.searchParams.delete("photo");
  explore.searchParams.set("view", "explore");
  if (selectedBase) explore.searchParams.set("photo", selectedBase);
  const exploreUrl = explore.toString();
  return { gallery: galleryUrl, explore: exploreUrl, current: exploreRequested ? exploreUrl : galleryUrl };
}

function validCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}
