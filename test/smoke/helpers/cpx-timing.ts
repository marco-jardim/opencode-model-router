import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Fields = Record<string, string | number | boolean | null | undefined>;
export interface TimingRecord extends Fields { point: string; at: number }

/** Diagnostic only: wall time correlates with the ledger/provider; durations use a monotonic clock. */
export class CpxTimings {
  readonly records: TimingRecord[] = [];
  dropped = 0;
  constructor(readonly startedAt = Date.now(), readonly limit = 512) {}
  mark(point: string, fields: Fields = {}): void {
    if (this.records.length >= this.limit) { this.dropped++; return; }
    const at = Date.now();
    this.records.push({ ...fields, point, at, elapsedMs: at - this.startedAt });
  }
  async span<T>(point: string, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    this.mark(`${point}.start`);
    let ok = false;
    try { const result = await work(); ok = true; return result; }
    finally { this.mark(`${point}.end`, { ok, durationMs: performance.now() - start }); }
  }
}

export const TIMING_DIRECTORY = "cpx-diagnostics";
export const TIMING_FILE_LIMIT = 256;
const FILE_BYTES_LIMIT = 512 * 1024;

/** Written OUTSIDE the git project. Exclusive numbered files bound disk use even across processes/restarts.
 * Hooks only buffer; the observer flushes asynchronously. Wrappers flush before a child and on completion.
 * No env, headers, message bodies, tool inputs/results or child output enter this journal. */
export const timingJournalSource = `import {open,readdir,appendFile} from 'node:fs/promises';
import path from 'node:path';
export async function createTimingJournal(directory,source,details={},limit=512){
 let file;
 try{
  const used=new Set(await readdir(directory));
  for(let i=0;i<${TIMING_FILE_LIMIT};i++){
   const name=i+'.jsonl';if(used.has(name))continue;
   try{const handle=await open(path.join(directory,name),'wx');await handle.close();file=path.join(directory,name);break;}
   catch(error){if(error.code!=='EEXIST')break;}
  }
 }catch{}
 let pending=[],count=0,bytes=0,chain=Promise.resolve(),ioMs=0,ioErrors=0;
 const mark=(point,fields={})=>{
  if(!file||count>limit)return;
  const row=JSON.stringify({...details,...fields,source,pid:process.pid,point:count===limit?'diagnostics.truncated':point,at:fields.at??Date.now(),seq:count++})+'\\n';
  if(bytes+Buffer.byteLength(row)>${FILE_BYTES_LIMIT}){count=limit+1;return;}
  bytes+=Buffer.byteLength(row);pending.push(row);
 };
 const flush=()=>{
  const text=pending.join('');pending=[];
  if(text)chain=chain.then(async()=>{const start=performance.now();try{await appendFile(file,text);}catch{ioErrors++;}finally{ioMs+=performance.now()-start;}});
  return chain;
 };
 return {mark,flush,stats:()=>({ioMs,ioErrors,available:!!file})};
}
`;

/** Metadata-only hooks already exposed by the pinned v2 SDK; no invented dispatch/verification events. */
export function timingObserverSource(root: string): string {
  return `import {appendFile} from 'node:fs/promises';
import {createTimingJournal} from ${JSON.stringify(pathToFileURL(path.join(root, TIMING_DIRECTORY, "journal.mjs")).href)};
export default {id:'cpx-e2e-observer',async setup(ctx){
 const at=Date.now();
 const timing=await createTimingJournal(${JSON.stringify(path.join(root, TIMING_DIRECTORY))},'observer',{instance:ctx.location.directory});
 timing.mark('plugin.setup.start',{at});
 // Only scalar metadata: no context/header/tool payload dumps, and no I/O awaited on a session hook.
 await ctx.session.hook('context',e=>timing.mark('session.context',{sessionID:e.sessionID}));
 let C15=false;
 try{await ctx.session.hook('compaction',e=>timing.mark('session.compaction',{sessionID:e.sessionID}));C15=true;}catch{}
 await appendFile(${JSON.stringify(path.join(root, "e2e-observer.jsonl"))},JSON.stringify({kind:'capabilities',C4:true,C15})+'\\n');
 try{
  await ctx.session.hook('prompt',e=>timing.mark('session.prompt',{sessionID:e.sessionID}));
  await ctx.session.hook('model.request',e=>timing.mark('session.model.request',{sessionID:e.sessionID,kind:e.kind}));
  await ctx.session.hook('http.request',e=>timing.mark('session.http.request',{sessionID:e.sessionID,kind:e.kind}));
  await ctx.permission.hook('evaluate',e=>timing.mark('permission.evaluate',{sessionID:e.sessionID,action:e.action}));
 }catch{timing.mark('diagnostics.hook-unavailable');}
 timing.mark('plugin.setup.end');
 const timer=setInterval(()=>{void timing.flush();},250);timer.unref();
 return async()=>{clearInterval(timer);timing.mark('plugin.dispose');await timing.flush();};
}};
`;
}

interface WrapperCommand { cwd: string; command: string; args: readonly string[] }
/** Keep generated tracked wrapper bytes identical between baseline/restart hosts (no per-run absolute path).
 * The diagnostic directory is a sibling of project/audit/slots, never a task change or scoped fixture file. */
export function timedWrapperSource(name: string, commands: readonly WrapperCommand[], selection = ""): string {
  return `import {spawnSync} from 'node:child_process';
import {readdirSync,readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const enteredAt=Date.now(),enteredMono=performance.now();
let directory=process.cwd();
while(!existsSync(path.join(directory,${JSON.stringify(TIMING_DIRECTORY)}))&&path.dirname(directory)!==directory)directory=path.dirname(directory);
let timing={mark:()=>{},flush:async()=>{},stats:()=>({available:false})};
try{
 const {createTimingJournal}=await import(pathToFileURL(path.join(directory,${JSON.stringify(TIMING_DIRECTORY)},'journal.mjs')).href);
 timing=await createTimingJournal(path.join(directory,${JSON.stringify(TIMING_DIRECTORY)}),'wrapper',{wrapper:${JSON.stringify(name)},cwd:process.cwd()},32);
}catch{} // Diagnostic failure must not change the real check's output/status.
timing.mark('wrapper.start',{at:enteredAt});
await timing.flush(); // Retain entry even if killed during phase selection, before any child starts.
let commands=${JSON.stringify(commands)},exitCode=0,completed=false;
try{
 timing.mark('selection.start');
 ${selection}
 timing.mark('selection.end',{commandCount:commands.length});
 for(const [index,c] of commands.entries()){
  // Persist a pending marker before spawnSync blocks the event loop; actual command times exclude this I/O.
  timing.mark('command.pending',{index,command:c.command,args:JSON.stringify(c.args),commandCwd:path.resolve(c.cwd)});
  await timing.flush();
  const start=performance.now();
  timing.mark('command.start',{index});
  const r=spawnSync(c.command,c.args,{cwd:path.resolve(c.cwd),env:{...process.env,CPX_E2E_REPORT_ROOT:process.cwd()},shell:false,encoding:'utf8',timeout:15000});
  timing.mark('command.end',{index,durationMs:performance.now()-start,childPid:r.pid,status:r.status,signal:r.signal,errorCode:r.error?.code??null});
  process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
  if(r.error)console.error(r.error.message);
  // Preserve the original wrapper's failure policy; the journal retains the child's unmodified status/signal.
  if(r.error||r.status!==0){exitCode=1;break;}
 }
 completed=true;
}finally{
 timing.mark('wrapper.end',{exitCode:completed?exitCode:1,completed,durationMs:performance.now()-enteredMono,...timing.stats()});
 await timing.flush();
}
if(exitCode)process.exit(exitCode);
`;
}

/** Bounded, partial-line-tolerant capture, including a killed wrapper's last persisted pending marker.
 * Merge by file/seq in the driver so a later cleanup read cannot erase an earlier snapshot. */
export async function collectTimingJournal(directory: string): Promise<{ records: TimingRecord[]; files: number; fileLimitReached: boolean; incompleteFiles: string[]; readErrors: string[] }> {
  const names = (await readdir(directory)).filter(name => /^\d+\.jsonl$/.test(name)).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]));
  const records: TimingRecord[] = [];
  const incompleteFiles: string[] = [];
  const readErrors: string[] = [];
  for (const file of names.slice(0, TIMING_FILE_LIMIT)) {
    try {
      const handle = await open(path.join(directory, file), "r");
      let text: string;
      try {
        const buffer = Buffer.alloc(FILE_BYTES_LIMIT);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally { await handle.close(); }
      if (text && !text.endsWith("\n")) incompleteFiles.push(file);
      for (const line of text.split("\n").slice(0, -1)) {
        try {
          const row: unknown = JSON.parse(line);
          if (row && typeof row === "object" && "point" in row && typeof row.point === "string" && "at" in row && typeof row.at === "number") records.push({ ...row, point: row.point, at: row.at, file });
        } catch { incompleteFiles.push(file); }
      }
    } catch { readErrors.push(file); }
  }
  return { records, files: names.length, fileLimitReached: names.length >= TIMING_FILE_LIMIT, incompleteFiles, readErrors };
}
