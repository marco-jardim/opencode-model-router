// QA-3.2-23 fixture (run as `node suite.js`), vitest-shaped output. Two problems in one command:
// - `always.txt` must say "green" and does not at any commit (a red base): `FAIL  always.txt > must be green`;
// - every `*.mod.js` under mods/ must load. A phase task that adds a module requiring a missing file breaks the collection
//   (an import error): vitest reports the file as failed, with no test id, and counts no test for it.
// The summary counts tests only, so the inventory {always.txt > must be green} looks complete although the collection
// failed. With OMR_FIXTURE_NO_SUMMARY set, the summary lines are left out (an incomplete inventory instead).
const fs = require("node:fs");
const path = require("node:path");

const broken = [];
const dir = path.resolve("mods");
let loaded = 0;
for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
  if (!name.endsWith(".mod.js")) continue;
  try {
    require(path.join(dir, name));
    loaded += 1;
  } catch (e) {
    broken.push({ name, message: e instanceof Error ? e.message.split("\n")[0] : String(e) });
  }
}
const red = fs.readFileSync("always.txt", "utf8").trim() !== "green";

console.log("");
console.log(" RUN  v2.1.9 " + process.cwd().replace(/\\/g, "/"));
console.log("");
for (const b of broken) {
  console.log(` FAIL  mods/${b.name} [ mods/${b.name} ]`);
  console.log(`Error: Failed to load mods/${b.name}: ${b.message.replace(/\\/g, "/")}`);
  console.log("");
}
if (red) {
  console.log(" FAIL  always.txt > must be green");
  console.log("AssertionError: expected 'red' to be 'green'");
  console.log("");
}
if (process.env.OMR_FIXTURE_NO_SUMMARY === undefined) {
  const files = 1 + loaded + broken.length;
  const failedFiles = (red ? 1 : 0) + broken.length;
  console.log(` Test Files  ${failedFiles > 0 ? `${failedFiles} failed | ` : ""}${files - failedFiles} passed (${files})`);
  console.log(`      Tests  ${red ? "1 failed | " : ""}${1 + loaded - (red ? 1 : 0)} passed (${1 + loaded})`);
}
process.exit(red || broken.length > 0 ? 1 : 0);
