// QA-3.2-22 fixture: the phase suite prints what vitest prints in a workspace with named projects, where every failing id
// carries the `|proj|` prefix. The checks treat it as the `npm test` command (package.json "test": "vitest run"), so a
// rerun asks the runner for the failing files; `|proj| test/a.test.ts` is no file, and a rerun that drops it runs nothing.
// `use.txt` names the lib version it expects: a task that edits only lib.txt breaks test/a.test.ts.
const fs = require("node:fs");

const lib = fs.readFileSync("lib.txt", "utf8").trim();
const use = fs.readFileSync("use.txt", "utf8").trim();
const ok = use === `expects ${lib}`;

console.log("");
console.log(" RUN  v2.1.9 " + process.cwd().replace(/\\/g, "/"));
console.log("");
if (ok) {
  console.log(" ✓ |proj| test/a.test.ts (1 test) 2ms");
  console.log("");
  console.log(" Test Files  1 passed (1)");
  console.log("      Tests  1 passed (1)");
  process.exit(0);
}
console.log(" ❯ |proj| test/a.test.ts (1 test | 1 failed) 3ms");
console.log("   × a > matches the lib");
console.log("");
console.log("⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯");
console.log("");
console.log(" FAIL  |proj| test/a.test.ts > a > matches the lib");
console.log(`AssertionError: expected '${use}' to be 'expects ${lib}'`);
console.log("");
console.log(" Test Files  1 failed (1)");
console.log("      Tests  1 failed (1)");
process.exit(1);
