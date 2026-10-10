import Pusher from "pusher";
import { config } from "../config.js";

/** PUSHER_* credentials present: the server can publish (dispatcher) and sign auth. */
export const realtimeEnabled = Boolean(config.pusherAppId && config.pusherKey && config.pusherSecret && config.pusherCluster);
/** Clients may subscribe: credentials AND an operator confirmed a running publisher (REALTIME_CLIENTS_ENABLED=on). */
export const clientRealtimeEnabled = realtimeEnabled && config.realtimeClientsEnabled;

const client = realtimeEnabled
  ? new Pusher({
      appId: config.pusherAppId,
      key: config.pusherKey,
      secret: config.pusherSecret,
      cluster: config.pusherCluster,
      useTLS: true,
      timeout: config.outboxPublishTimeoutMs,
    })
  : null;

/** Rejects on HTTP/network failure so the dispatcher can retry. */
export async function publish(channels, event, data) {
  if (!client) throw new Error("Realtime is not configured.");
  await client.trigger(channels, event, data);
}

export function authorizeChannel(socketId, channelName) {
  return client.authorizeChannel(socketId, channelName);
}
