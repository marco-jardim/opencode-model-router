// Passes only when a build output exists: a stale, ignored dist/out.js would make it pass wrongly.
const fs = require("node:fs");

if (!fs.existsSync("dist/out.js")) {
  console.error("missing build output dist/out.js");
  process.exit(1);
}
console.log("ok");
