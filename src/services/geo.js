import { ApiError } from "../errors.js";

const EARTH_M = 6371008.8;
const rad = (deg) => (deg * Math.PI) / 180;

/** Local metres (east, north) of `p` relative to `origin`; accurate at campus scale (equirectangular). */
function toMetres(origin, [lat, lng]) {
  return [rad(lng - origin[1]) * Math.cos(rad(origin[0])) * EARTH_M, rad(lat - origin[0]) * EARTH_M];
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Where a point is relative to a polygon of [lat, lng] pairs: inside, on/near the edge (distance ≤ tolerance),
 * or outside. Distance is in metres to the nearest edge (0 when inside).
 */
export function locatePoint(point, polygon, toleranceMeters = 0) {
  const origin = point;
  const p = [0, 0];
  const ring = polygon.map((v) => toMetres(origin, v));
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  let distance = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) distance = Math.min(distance, distanceToSegment(p, ring[j], ring[i]));
  if (inside) return { status: "INSIDE", distanceMeters: 0 };
  return { status: distance <= toleranceMeters ? "WITHIN_TOLERANCE" : "OUTSIDE", distanceMeters: Math.round(distance * 10) / 10 };
}

/** Validates an admin-supplied perimeter: 3–200 [lat, lng] vertices in range, not all identical. Returns it closed-free. */
export function validatePerimeter(perimeter) {
  if (perimeter === null) return null;
  const bad = (message) => new ApiError(400, message, "INVALID_GEOMETRY");
  if (!Array.isArray(perimeter) || perimeter.length < 3 || perimeter.length > 200) {
    throw bad("perimeter must be a list of 3 to 200 [lat, lng] points.");
  }
  const points = perimeter.map((v) => {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw bad("Each perimeter point must be [lat, lng] numbers.");
    }
    const [lat, lng] = v;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw bad("Perimeter coordinates are out of range.");
    return [Number(lat.toFixed(6)), Number(lng.toFixed(6))];
  });
  const first = points[0];
  const last = points[points.length - 1];
  const open = first[0] === last[0] && first[1] === last[1] ? points.slice(0, -1) : points;
  if (new Set(open.map((p) => p.join(","))).size < 3) throw bad("perimeter needs at least 3 distinct points.");
  return open;
}

/**
 * Display location for a report on the campus map. Raw GPS is always returned untouched as `rawGps`; only the
 * display pin is derived:
 *  - GPS when the report has GPS and the building has no perimeter, or the GPS is inside / within tolerance of it;
 *  - BUILDING_DEFAULT when GPS is missing or falls outside the tagged building, and the building has a default pin;
 *  - NONE otherwise (listed in the table view, not pinned).
 * The report's building is never changed by this function.
 */
export function effectiveLocation({ gpsLat, gpsLng }, building) {
  const hasGps = gpsLat !== null && gpsLat !== undefined && gpsLng !== null && gpsLng !== undefined;
  const rawGps = hasGps ? { lat: Number(gpsLat), lng: Number(gpsLng) } : null;
  const pin = building && building.defaultLat !== null && building.defaultLat !== undefined
    ? { lat: Number(building.defaultLat), lng: Number(building.defaultLng) }
    : null;
  if (hasGps) {
    if (!building?.perimeter) {
      return { source: "GPS", lat: rawGps.lat, lng: rawGps.lng, rawGps, gpsCheck: building ? "NO_PERIMETER" : "NO_BUILDING" };
    }
    const check = locatePoint([rawGps.lat, rawGps.lng], building.perimeter, building.toleranceMeters ?? 0);
    if (check.status !== "OUTSIDE") return { source: "GPS", lat: rawGps.lat, lng: rawGps.lng, rawGps, gpsCheck: check.status };
    if (pin) return { source: "BUILDING_DEFAULT", ...pin, rawGps, gpsCheck: "OUTSIDE", gpsDistanceMeters: check.distanceMeters };
    return { source: "NONE", lat: null, lng: null, rawGps, gpsCheck: "OUTSIDE", gpsDistanceMeters: check.distanceMeters };
  }
  if (pin) return { source: "BUILDING_DEFAULT", ...pin, rawGps: null, gpsCheck: "NO_GPS" };
  return { source: "NONE", lat: null, lng: null, rawGps: null, gpsCheck: "NO_GPS" };
}
