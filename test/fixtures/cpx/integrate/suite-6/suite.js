// The phase suite of the fixture. It runs the whole repository's invariant, not just the files a task touched:
// use.txt names the lib version it expects, so a task that only edits lib.txt breaks the suite in a file it does not touch.
// A counter file named by OMR_FIXTURE_FLAKY (when set) makes the first run fail and later runs pass.
const fs = require("node:fs");

const flaky = process.env.OMR_FIXTURE_FLAKY;
if (flaky) {
  const n = fs.existsSync(flaky) ? Number(fs.readFileSync(flaky, "utf8")) : 0;
  fs.writeFileSync(flaky, String(n + 1));
  if (n === 0) {
    console.error("flaky failure on the first run");
    process.exit(1);
  }
}

const lib = fs.readFileSync("lib.txt", "utf8").trim();
const use = fs.readFileSync("use.txt", "utf8").trim();
if (use !== `expects ${lib}`) {
  console.error(`FAIL use.txt > expects the current lib: "${use}" vs "${lib}"`);
  process.exit(1);
}
console.log("suite ok");
