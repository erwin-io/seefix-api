import { pathToFileURL } from "node:url";
import { app } from "./src/app.js";
import { config, validateRuntimeConfig } from "./src/config.js";
import { query } from "./src/database.js";
import { startDispatcher } from "./src/realtime/outbox-dispatcher.js";
import { clientRealtimeEnabled, publish, realtimeEnabled } from "./src/realtime/pusher-client.js";

validateRuntimeConfig();
const isDirectRun=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(isDirectRun){app.listen(config.port,config.host,()=>{console.log(`SEEFIX API running at http://${config.host}:${config.port}`);console.log(`SEEFIX Agent target: ${config.agentUrl}`);console.log("Static UI: disabled (mobile/web clients use JSON API only)");});
  if(realtimeEnabled&&config.outboxDispatcherEnabled){startDispatcher({q:query,publish,intervalMs:config.outboxPollMs,batchSize:config.outboxBatchSize,maxAttempts:config.outboxMaxAttempts,leaseSeconds:config.outboxLeaseSeconds,baseMs:config.outboxBackoffBaseMs,maxMs:config.outboxBackoffMaxMs,maxAgeMinutes:config.outboxMaxAgeMinutes});console.log("Realtime: OutboxEvents -> Pusher dispatcher running");}
  else console.log("Realtime: dispatcher off in this process (OutboxEvents stay PENDING unless a dedicated worker runs)");
  console.log(clientRealtimeEnabled?"Realtime clients: enabled (REALTIME_CLIENTS_ENABLED=on; a publisher must be running)":"Realtime clients: disabled (clients poll)");}
export default app;
