/** Test-only silent leaf for C16's process-lifetime observation. No host/plugin dependencies. */
const { writeFileSync } = require("node:fs");
const path = require("node:path");

const [mode, token, dir] = process.argv.slice(2);
if (mode !== "leaf" || !/^[A-Za-z0-9_-]+$/.test(token || "") || !dir) process.exit(2);
try { writeFileSync(path.join(dir, `${token}.pid.json`), JSON.stringify({ pid: process.pid, ppid: process.ppid, token, startedAt: Date.now() })); }
catch { process.exit(1); }
let counter = 0;
const beat = () => {
  try { writeFileSync(path.join(dir, `${token}.beat`), String(++counter)); }
  catch { process.exit(1); } // Stay silent even if failure-path cleanup has already removed the directory.
};
beat();
const timer = setInterval(beat, 200);
setTimeout(() => { clearInterval(timer); process.exit(0); }, 15 * 60 * 1000);
