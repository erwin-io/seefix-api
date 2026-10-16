import test from "node:test";
import assert from "node:assert/strict";
import { effectiveLocation, locatePoint, perimeterCenter, validatePerimeter } from "../src/services/geo.js";
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
  assert.equal(noPin.source, "BUILDING_DEFAULT", "outside with no default pin: shown at the perimeter centre");
  assert.equal(noPin.defaultFrom, "PERIMETER_CENTER");
  assert.deepEqual([noPin.lat, noPin.lng], [14.60045, 121.00045]);
  assert.deepEqual(noPin.rawGps, { lat: 14.7, lng: 121.1 });
  assert.equal(effectiveLocation({ gpsLat: null, gpsLng: null }, { perimeter: null, defaultLat: null }).source, "NONE", "no geometry at all");
});

test("perimeter centre is the area centroid, not the vertex average", () => {
  assert.deepEqual(perimeterCenter(SQUARE), { lat: 14.60045, lng: 121.00045 });
  // An L shape: extra vertices on one side must not drag the centre toward them.
  const extra = [[14.6000, 121.0000], [14.6000, 121.0009], [14.6009, 121.0009], [14.6009, 121.0008], [14.6009, 121.0007], [14.6009, 121.0000]];
  assert.deepEqual(perimeterCenter(extra), { lat: 14.60045, lng: 121.00045 });
  assert.equal(perimeterCenter(null), null);
  assert.equal(perimeterCenter([[1, 1], [2, 2]]), null);
});

test("a saved map correction wins for display, keeps raw GPS and the GPS check", () => {
  const building = { perimeter: SQUARE, toleranceMeters: 25, defaultLat: null };
  const correction = { lat: "14.6002", lng: "121.0003", source: "MANUAL", reason: "Pinned by staff", updatedAt: "2026-10-17T00:00:00Z", updatedBy: "Staff" };
  const fixed = effectiveLocation({ gpsLat: 14.7, gpsLng: 121.1, correction }, building);
  assert.equal(fixed.source, "CORRECTED");
  assert.deepEqual([fixed.lat, fixed.lng], [14.6002, 121.0003]);
  assert.deepEqual(fixed.rawGps, { lat: 14.7, lng: 121.1 }, "raw GPS untouched");
  assert.equal(fixed.gpsCheck, "OUTSIDE");
  assert.equal(fixed.correction.reason, "Pinned by staff");
  assert.equal(effectiveLocation({ gpsLat: null, gpsLng: null, correction }, null).source, "CORRECTED", "works without a building");
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

test("location suggestion: linked building first, else one loosely matching building, never a guess", async () => {
  const { suggestLocation } = await import("../src/routes/buildings.js");
  const buildings = [
    { id: "b1", code: "OLD_BUILDING", name: "Old Building", defaultLat: null, defaultLng: null, perimeter: SQUARE },
    { id: "b2", code: "ANNEX_1", name: "Annex 1 Building", defaultLat: 14.61, defaultLng: 121.01, perimeter: null },
    { id: "b3", code: "ANNEX_2", name: "Annex 2 Building", defaultLat: 14.62, defaultLng: 121.02, perimeter: null },
    { id: "b4", code: "CBE", name: "CBE Building", defaultLat: null, defaultLng: null, perimeter: null },
  ];
  assert.deepEqual(suggestLocation({ buildingId: "b2", buildingText: "x" }, buildings),
    { lat: 14.61, lng: 121.01, buildingId: "b2", buildingName: "Annex 1 Building", basis: "LINKED_BUILDING" });
  const old = suggestLocation({ buildingId: null, buildingText: "old bldg." }, buildings);
  assert.equal(old.buildingId, "b1");
  assert.equal(old.basis, "SIMILAR_NAME");
  assert.deepEqual([old.lat, old.lng], [14.60045, 121.00045], "perimeter centre when there is no pin");
  assert.equal(suggestLocation({ buildingId: null, buildingText: "Annex" }, buildings), null, "ambiguous: Annex 1 or 2");
  assert.equal(suggestLocation({ buildingId: null, buildingText: "CBE" }, buildings), null, "match without any geometry");
  assert.equal(suggestLocation({ buildingId: null, buildingText: null }, buildings), null);
});

test("campus settings validation and defaults", async () => {
  const { validateCampus, CAMPUS_DEFAULTS } = await import("../src/services/campus-settings.js");
  assert.deepEqual(validateCampus({ centerLat: 10.326321206548808, centerLng: 123.95499535428095, radiusMeters: 600, minZoom: 16 }),
    { centerLat: 10.3263212, centerLng: 123.9549954, radiusMeters: 600, minZoom: 16 });
  assert.deepEqual([CAMPUS_DEFAULTS.centerLat, CAMPUS_DEFAULTS.centerLng], [10.326321, 123.954995]);
  for (const bad of [{}, { ...CAMPUS_DEFAULTS, centerLng: 483.9 }, { ...CAMPUS_DEFAULTS, radiusMeters: 50 },
    { ...CAMPUS_DEFAULTS, radiusMeters: 600.5 }, { ...CAMPUS_DEFAULTS, minZoom: 22 }, { ...CAMPUS_DEFAULTS, centerLat: "10" }]) {
    assert.throws(() => validateCampus(bad), /INVALID_CAMPUS|must be/);
  }
});
