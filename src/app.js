import express from "express";
import cors from "cors";
import { config } from "./config.js";
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
import { notFound, errorHandler } from "./middleware/errors.js";

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
if (config.corsOrigins.length) {
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || config.corsOrigins.includes(origin))
          return cb(null, true);
        cb(new Error("Origin is not allowed by CORS policy."));
      },
      credentials: false,
    }),
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
app.use("/api/auth", authRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/maintenance", maintenanceRoutes);
app.use("/api/reference", referenceRoutes);
app.use("/api/procurement", procurementRoutes);
app.use("/api/work-orders", workOrderRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/knowledge", adminKnowledgeRoutes);
app.use(notFound);
app.use(errorHandler);