import { Router } from "express";
import { config } from "../config.js";
import { query } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { canSubscribe, channel } from "../realtime/channels.js";
import { authorizeChannel, realtimeEnabled } from "../realtime/pusher-client.js";

const router = Router();
router.use(requireAuth);

// Public key/cluster only; the secret never leaves the server.
router.get("/config", (req, res) =>
  res.json({
    enabled: realtimeEnabled,
    key: realtimeEnabled ? config.pusherKey : null,
    cluster: realtimeEnabled ? config.pusherCluster : null,
    userChannel: channel.user(req.user.id),
  }),
);

// pusher-js posts socket_id + channel_name (form-urlencoded) with the Bearer header.
router.post("/auth", async (req, res, next) => {
  try {
    if (!realtimeEnabled) throw new ApiError(503, "Realtime is not configured.", "REALTIME_DISABLED");
    const socketId = String(req.body?.socket_id || "");
    const channelName = String(req.body?.channel_name || "");
    if (!/^\d+\.\d+$/.test(socketId)) throw new ApiError(400, "socket_id is invalid.", "VALIDATION_ERROR");
    if (!(await canSubscribe(req.user, channelName, query))) {
      throw new ApiError(403, "You cannot subscribe to this channel.", "FORBIDDEN");
    }
    res.json(authorizeChannel(socketId, channelName));
  } catch (error) {
    next(error);
  }
});

export default router;
