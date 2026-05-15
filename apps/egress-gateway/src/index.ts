import { loadConfig } from "@agent-pool/config";

import { createEgressGateway } from "./gateway";

const gateway = createEgressGateway({ config: loadConfig() });

gateway.listen().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

process.on("SIGTERM", () => {
  gateway.close().finally(() => process.exit(0));
});
