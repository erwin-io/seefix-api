import { config } from "./config.js";

export class AgentClientError extends Error {
  constructor(
    message,
    { code = "AGENT_ERROR", status, upstreamDetail, cause } = {},
  ) {
    super(message, { cause });
    this.name = "AgentClientError";
    this.code = code;
    this.status = status;
    this.upstreamDetail = upstreamDetail;
  }
}

async function agentRequest(
  path,
  {
    method = "GET",
    body,
    timeoutMs = config.agentTimeoutMs,
    auth = true,
  } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.agentUrl}${path}`, {
      method,
      headers: {
        ...(auth ? { "X-SEEFIX-AGENT-KEY": config.agentSecret } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { detail: text };
    }

    if (!response.ok) {
      const code =
        response.status === 401
          ? "AGENT_AUTH_ERROR"
          : "AGENT_RESPONSE_ERROR";

      throw new AgentClientError(
        payload?.detail || `Agent returned HTTP ${response.status}.`,
        {
          code,
          status: response.status,
          upstreamDetail: text.slice(0, 2000),
        },
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof AgentClientError) throw error;

    if (error?.name === "AbortError") {
      throw new AgentClientError("SEEFIX Agent request timed out.", {
        code: "AGENT_TIMEOUT",
        cause: error,
      });
    }

    throw new AgentClientError(
      `Unable to reach SEEFIX Agent at ${config.agentUrl}.`,
      {
        code: "AGENT_UNAVAILABLE",
        cause: error,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

export const agentClient = {
  health: () =>
    agentRequest("/health", {
      auth: false,
      timeoutMs: config.agentHealthTimeoutMs,
    }),

  processReport: (reportId) =>
    agentRequest(`/api/reports/${reportId}/process`, {
      method: "POST",
    }),

  reportStatus: (reportId) =>
    agentRequest(`/api/reports/${reportId}/status`),

  generateMaintenanceRequest: (reportId) =>
    agentRequest(
      `/api/reports/${reportId}/maintenance-request/generate`,
      { method: "POST" },
    ),

  previewProcurementPackage: (maintenanceRequestId) =>
    agentRequest(
      `/api/maintenance-requests/${maintenanceRequestId}/procurement-package/preview`,
      { method: "POST" },
    ),

  draftClarification: (handoffId, clarificationId) =>
    agentRequest(
      `/api/procurement/${handoffId}/clarifications/${clarificationId}/draft`,
      { method: "POST" },
    ),

  previewInternalWorkOrder: (maintenanceReviewId) =>
    agentRequest(
      `/api/maintenance-reviews/${maintenanceReviewId}/work-order/preview`,
      { method: "POST" },
    ),

  previewProcurementWorkOrder: (procurementOutcomeId) =>
    agentRequest(
      `/api/procurement-outcomes/${procurementOutcomeId}/work-order/preview`,
      { method: "POST" },
    ),

  reviewWorkOrder: (workOrderId) =>
    agentRequest(`/api/work-orders/${workOrderId}/review`, {
      method: "POST",
    }),

  processCompletion: (workOrderId) =>
    agentRequest(`/api/work-orders/${workOrderId}/completion/process`, {
      method: "POST",
    }),

  completionStatus: (workOrderId) =>
    agentRequest(`/api/work-orders/${workOrderId}/completion/status`),

  runMonitor: () =>
    agentRequest("/api/monitor/run", {
      method: "POST",
    }),
};

export async function bestEffort(label, action) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    console.warn(`[AGENT] ${label} failed:`, error.message);
    return { ok: false, error: error.message };
  }
}
