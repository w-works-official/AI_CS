// Windows on ARM can execute the published x64 workerd binary via emulation.
// Wrangler spawns a child Node process and forwards this preload argument.
/* eslint-disable @typescript-eslint/no-require-imports */
const os = require("node:os");
if (process.platform === "win32" && os.arch() === "arm64") os.arch = () => "x64";
