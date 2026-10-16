import test from "node:test";
import assert from "node:assert/strict";
import { effectiveLocation, locatePoint, validatePerimeter } from "../src/services/geo.js";
import { likePattern } from "../src/routes/search.js";
import { dateRange } from "../src/routes/analytics.js";

// ~100 m × ~100 m square near 14.6°N (Manila latitudes).
const SQUARE = [[14.6000, 121.0000], [14.6000, 121.0009], [14.6009, 121.0009], [14.6009, 121.0000]];

test("point in polygon: inside, outside, near-edge within tolerance", () => {
  assert.equal(locatePoint([14.6004, 121.0004], SQUARE).status, "INSIDE");
  const out = locatePoint([14.6020, 121.0004], SQUARE, 25); // ~122 m north of the top edge
  assert.equal(out.status, "OUTSIDE");
  assert.ok(out.distanceMeters > 100 && out.distanceMeters < 140, String(out.distanceMeters));
  const near = locatePoint([14.6010, 121.0004], SQUARE, 25); // ~11 m north of the edge
  assert.equal(near.status, "WITHIN_TOLERANCE");
  assert.equal(locatePoint([14.6010, 121.0004], SQUARE, 0).status, "OUTSIDE", "tolerance 0 is strict");
});

test("display location keeps raw GPS and only falls back to the building pin when GPS is outside or missing", () => {
  const building = { perimeter: SQUARE, toleranceMeters: 25, defaultLat: 14.60045, defaultLng: 121.00045 };
  const inside = effectiveLocation({ gpsLat: "14.6004", gpsLng: "121.0004" }, building);
  assert.equal(inside.source, "GPS");
  assert.deepEqual(inside.rawGps, { lat: 14.6004, lng: 121.0004 });

  const far = effectiveLocation({ gpsLat: 14.7, gpsLng: 121.1 }, building);
  assert.equal(far.source, "BUILDING_DEFAULT");
  assert.equal(far.gpsCheck, "OUTSIDE");
  assert.deepEqual(far.rawGps, { lat: 14.7, lng: 121.1 }, "raw GPS is preserved, never rewritten");
  assert.equal(far.lat, 14.60045);

  assert.equal(effectiveLocation({ gpsLat: null, gpsLng: null }, building).source, "BUILDING_DEFAULT");
  assert.equal(effectiveLocation({ gpsLat: null, gpsLng: null }, null).source, "NONE");
  assert.equal(effectiveLocation({ gpsLat: 1, gpsLng: 2 }, null).gpsCheck, "NO_BUILDING");
  const noPin = effectiveLocation({ gpsLat: 14.7, gpsLng: 121.1 }, { perimeter: SQUARE, toleranceMeters: 0, defaultLat: null });
  assert.equal(noPin.source, "NONE", "outside with no default pin: not pinned, still listed");
});

test("perimeter validation", () => {
  assert.equal(validatePerimeter(null), null);
  assert.deepEqual(validatePerimeter([...SQUARE, SQUARE[0]]), SQUARE, "a closing point is dropped");
  for (const bad of [[], [[1, 2], [3, 4]], [[1, 2], [3, 4], ["x", 5]], [[91, 0], [0, 0], [1, 1]], [[1, 1], [1, 1], [1, 1]], "polygon", [[1, 2, 3], [1, 1], [2, 2]]]) {
    assert.throws(() => validatePerimeter(bad), /INVALID|perimeter|Perimeter/);
  }
});

test("search text matches literally: LIKE wildcards are escaped", () => {
  assert.equal(likePattern("RPT-2026"), "%RPT-2026%");
  assert.equal(likePattern("100%_done\\"), "%100\\%\\_done\\\\%");
  assert.equal(likePattern("' OR 1=1 --"), "%' OR 1=1 --%", "quotes stay data (bound parameter)");
});

test("analytics date range: defaults, inclusive end, validation", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const d = dateRange({}, now);
  assert.equal(d.to.toISOString(), "2026-10-17T00:00:00.000Z");
  assert.equal(d.from.toISOString(), "2026-09-17T00:00:00.000Z");
  const r = dateRange({ from: "2026-10-01", to: "2026-10-01" });
  assert.equal(r.to - r.from, 86_400_000, "a single day");
  for (const bad of [{ from: "2026-13-01" }, { from: "2026-02-30" }, { from: "yesterday" }, { from: "2026-10-05", to: "2026-10-01" }, { from: "2020-01-01", to: "2026-01-01" }, { to: "2026-10-01'--" }]) {
    assert.throws(() => dateRange(bad, now), { code: "INVALID_DATE" });
  }
});
