import { ApiError } from "../errors.js";
import { query } from "../database.js";
import { getSetting } from "./settings.js";

/** dbo."SystemSettings" key of the campus map area (no migration: defaults apply until an admin saves it). */
export const CAMPUS_KEY = "campus.map";

/** The campus centre given by the owner (2026-10-17); radius and zoom are editable in Building settings. */
export const CAMPUS_DEFAULTS = Object.freeze({ centerLat: 10.326321, centerLng: 123.954995, radiusMeters: 600, minZoom: 16 });
export const CAMPUS_LIMITS = Object.freeze({ radiusMeters: [100, 5000], minZoom: [10, 18] });

const bad = (message) => new ApiError(400, message, "INVALID_CAMPUS_SETTINGS");
const round7 = (n) => Number(n.toFixed(7));

/** Validates a full settings body ({ centerLat, centerLng, radiusMeters, minZoom }). */
export function validateCampus(body) {
  const { centerLat, centerLng, radiusMeters, minZoom } = body ?? {};
  if (typeof centerLat !== "number" || typeof centerLng !== "number" || !Number.isFinite(centerLat) || !Number.isFinite(centerLng)
    || Math.abs(centerLat) > 90 || Math.abs(centerLng) > 180) {
    throw bad("centerLat and centerLng must be valid latitude/longitude numbers.");
  }
  const [rMin, rMax] = CAMPUS_LIMITS.radiusMeters;
  if (!Number.isInteger(radiusMeters) || radiusMeters < rMin || radiusMeters > rMax) {
    throw bad(`radiusMeters must be a whole number from ${rMin} to ${rMax}.`);
  }
  const [zMin, zMax] = CAMPUS_LIMITS.minZoom;
  if (!Number.isInteger(minZoom) || minZoom < zMin || minZoom > zMax) throw bad(`minZoom must be a whole number from ${zMin} to ${zMax}.`);
  return { centerLat: round7(centerLat), centerLng: round7(centerLng), radiusMeters, minZoom };
}

/** Saved settings merged over the defaults; an invalid stored value falls back to the defaults. */
export async function readCampus(client = { query }) {
  const stored = await getSetting(client, CAMPUS_KEY, null);
  if (!stored) return { ...CAMPUS_DEFAULTS, isDefault: true };
  try {
    return { ...validateCampus({ ...CAMPUS_DEFAULTS, ...stored }), isDefault: false };
  } catch {
    return { ...CAMPUS_DEFAULTS, isDefault: true };
  }
}
