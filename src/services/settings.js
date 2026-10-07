export async function getSetting(client, key, fallback = null) {
  const result = await client.query(`SELECT "Value" AS value FROM "dbo"."SystemSettings" WHERE "Key"=$1`, [key]);
  return result.rows[0]?.value ?? fallback;
}

export function settingBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

export function settingInt(value, fallback) {
  const n = Number.parseInt(value, 10); return Number.isFinite(n) ? n : fallback;
}
