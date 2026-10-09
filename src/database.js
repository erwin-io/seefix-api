import fs from "node:fs";
import pg from "pg";
import { config } from "./config.js";
import { ApiError } from "./errors.js";

const { Pool } = pg;

function sslOptions() {
  const mode = config.databaseSslMode;
  if (["disable", "allow", "prefer"].includes(mode)) return false;
  if (mode === "require") return { rejectUnauthorized: false };
  const ssl = { rejectUnauthorized: true };
  if (config.databaseSslRootCert) ssl.ca = fs.readFileSync(config.databaseSslRootCert, "utf8");
  return ssl;
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  connectionTimeoutMillis: config.databaseConnectTimeoutMs,
  application_name: "seefix-api",
  ssl: sslOptions(),
});

pool.on("error", (error) => console.error("[DB POOL] Unexpected idle-client error:", error.message));

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(userId, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function databaseHealth() {
  try {
    const result = await query("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  } catch { return false; }
}

export function mapDatabaseError(error) {
  if (error instanceof ApiError) return error;
  if (error?.code === "23505") {
    const name = String(error.constraint || '').toLowerCase();
    if (name.includes('ux_reports_oneactiveperreporter'))
      return new ApiError(409, 'You already have an active report. Open My Reports before submitting another.', 'ACTIVE_REPORT_EXISTS');
    if (name.includes('users_email')) return new ApiError(409, 'Email is already in use.', 'EMAIL_IN_USE');
    if (name.includes('users_username')) return new ApiError(409, 'Username is already in use.', 'USERNAME_IN_USE');
    return new ApiError(409, 'A record with the same unique value already exists.', 'CONFLICT');
  }
  if (error?.code === "23503") return new ApiError(409, "The operation references a missing or protected record.", "FOREIGN_KEY_CONFLICT");
  if (error?.code === "23514") return new ApiError(409, "The operation violates the SEEFIX workflow contract.", "CHECK_CONSTRAINT", error.constraint);
  if (error?.code === "22P02") return new ApiError(400, "One of the supplied identifiers or values is invalid.", "INVALID_VALUE");
  return error;
}
