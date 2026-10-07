import { pathToFileURL } from "node:url";
import { app } from "./src/app.js";
import { config, validateRuntimeConfig } from "./src/config.js";

validateRuntimeConfig();
const isDirectRun=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(!process.env.VERCEL&&isDirectRun){app.listen(config.port,config.host,()=>{console.log(`SEEFIX API running at http://${config.host}:${config.port}`);console.log(`SEEFIX Agent target: ${config.agentUrl}`);console.log("Static UI: disabled (mobile/web clients use JSON API only)");});}
export default app;
