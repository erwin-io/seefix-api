import Pusher from "pusher";
import { config } from "./config.js";

export const realtimeEnabled = Boolean(
  config.pusherAppId && config.pusherKey && config.pusherSecret && config.pusherCluster,
);

const pusher = realtimeEnabled
  ? new Pusher({
      appId: config.pusherAppId,
      key: config.pusherKey,
      secret: config.pusherSecret,
      cluster: config.pusherCluster,
      useTLS: true,
    })
  : null;

export const userChannel = (userId) => `private-user-${userId}`;

/** Best-effort: realtime is a hint to refetch, never the source of truth. */
export function publishToUser(userId, event, data) {
  if (!pusher || !userId) return;
  pusher.trigger(userChannel(userId), event, data).catch((error) =>
    console.warn("[REALTIME] publish failed:", error?.message || error),
  );
}

export function authorizeChannel(socketId, channel) {
  return pusher.authorizeChannel(socketId, channel);
}
