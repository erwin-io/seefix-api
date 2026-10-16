import express from "express";
import cors from "cors";
import { config, validateRuntimeConfig } from "./config.js";
import { databaseHealth } from "./database.js";
import { agentClient, bestEffort } from "./agent-client.js";
import authRoutes from "./routes/auth.js";
import reportRoutes from "./routes/reports.js";
import notificationRoutes from "./routes/notifications.js";
import maintenanceRoutes from "./routes/maintenance.js";
import referenceRoutes from "./routes/reference.js";
import procurementRoutes from "./routes/procurement.js";
import workOrderRoutes from "./routes/work-orders.js";
import adminRoutes from "./routes/admin.js";
import adminKnowledgeRoutes from "./routes/admin-knowledge.js";
import realtimeRoutes from "./routes/realtime.js";
import uploadRoutes from "./routes/uploads.js";
import syncRoutes from "./routes/sync.js";
import searchRoutes from "./routes/search.js";
import analyticsRoutes from "./routes/analytics.js";
import { adminBuildings, mapRoutes } from "./routes/buildings.js";
import { dispatchAfterWrite } from "./realtime/dispatch-now.js";
import { notFound, errorHandler } from "./middleware/errors.js";

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
if (config.corsOrigins.length) {
  app.use(
    // Listed origins get Access-Control-Allow-Origin; any other origin just doesn't, so the browser blocks it.
    // Never reject on Origin server-side: proxied same-site requests (the web admin's /api rewrite) carry the
    // browser's Origin too, and auth is a bearer token, not a cookie, so there is nothing to protect by refusing.
    cors({ origin: config.corsOrigins, credentials: false }),
  );
}
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.get("/", (_req, res) =>
  res.json({
    service: "seefix-api",
    version: "2.0.0",
    ui: false,
    architecture: "node-business-api-postgresql-fastapi-agent",
  }),
);
app.get("/health", async (_req, res) => {
  const database = await databaseHealth();
  const agent = await bestEffort("health", () => agentClient.health());
  const status =
    database && agent.ok && agent.value?.status === "ok" ? "ok" : "degraded";
  res
    .status(status === "ok" ? 200 : 503)
    .json({
      status,
      components: {
        database: { reachable: database },
        agent: {
          reachable: agent.ok,
          response: agent.ok ? agent.value : undefined,
        },
      },
    });
});
if (config.outboxDispatchAfterWrite) app.use("/api", dispatchAfterWrite());
app.use("/api/auth", authRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/maintenance", maintenanceRoutes);
app.use("/api/reference", referenceRoutes);
app.use("/api/procurement", procurementRoutes);
app.use("/api/work-orders", workOrderRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/knowledge", adminKnowledgeRoutes);
app.use("/api/admin/buildings", adminBuildings);
app.use("/api/realtime", realtimeRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/map", mapRoutes);
app.use(notFound);
app.use(errorHandler);

// Vercel's Express preset uses this file (it imports express) as the function entry, not server.js:
// it needs a default export, and server.js's startup config check doesn't run there.
if (process.env.VERCEL) validateRuntimeConfig();
export default app;