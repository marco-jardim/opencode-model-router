// The "typecheck" of the fixture: fails when any file under src/ contains the word BAD.
// A counter file named by OMR_FIXTURE_FLAKY (when set) makes the first run fail and later runs pass.
const fs = require("node:fs");
const path = require("node:path");

const flaky = process.env.OMR_FIXTURE_FLAKY;
if (flaky) {
  const n = fs.existsSync(flaky) ? Number(fs.readFileSync(flaky, "utf8")) : 0;
  fs.writeFileSync(flaky, String(n + 1));
  if (n === 0) {
    console.error("flaky failure on the first run");
    process.exit(1);
  }
}

let bad = [];
for (const name of fs.readdirSync("src")) {
  if (/BAD/.test(fs.readFileSync(path.join("src", name), "utf8"))) bad.push(name);
}
if (bad.length > 0) {
  console.error("check failed: BAD in " + bad.join(", "));
  process.exit(1);
}
console.log("ok");
