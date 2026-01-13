// src/shared/resource-utils.ts
import * as os from "os";
function getSystemResources() {
  return {
    freeRAM: os.freemem(),
    totalRAM: os.totalmem(),
    cpuCores: os.cpus().length,
    loadAvg: os.loadavg()
  };
}
export {
  getSystemResources
};
