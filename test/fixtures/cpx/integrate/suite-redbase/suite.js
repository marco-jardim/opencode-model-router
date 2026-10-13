// Two independent checks in one command. `always.txt` must say "green": it does not at any commit (a red base).
// `use.txt` names the lib version it expects, so a task that only edits lib.txt breaks it in a file it does not touch.
const fs = require("node:fs");

let failed = 0;
const fail = (file, message) => {
  failed += 1;
  console.error(`FAIL ${file} > ${message}`);
};

const always = fs.readFileSync("always.txt", "utf8").trim();
if (always !== "green") fail("always.txt", `must be green, is "${always}"`);

const lib = fs.readFileSync("lib.txt", "utf8").trim();
const use = fs.readFileSync("use.txt", "utf8").trim();
if (use !== `expects ${lib}`) fail("use.txt", `expects the current lib: "${use}" vs "${lib}"`);

if (failed > 0) process.exit(1);
console.log("suite ok");
