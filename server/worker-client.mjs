import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class WorkerClient {
  constructor({ timeoutMs = 150000, hardTimeoutMs = 1800000, executable = fileURLToPath(new URL('./Worker-equations.exe', import.meta.url)), args = [] } = {}) {
    this.timeoutMs = timeoutMs;
    this.hardTimeoutMs = hardTimeoutMs;
    this.late = [];
    this.executable = executable;
    this.args = args;
    this.chain = Promise.resolve();
    this.failed = null;
  }
  start() {
    if (this.failed) throw this.failed;
    if (this.child) return;
    this.child = spawn(this.executable, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdin.on('error', e => this.fail(e));
    this.child.stderr.on('data', d => process.stderr.write(d));
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', (code, signal) => this.fail(new Error(`CAD worker stopped (${code ?? signal}); reopen managed copies in a new MCP session.`)));
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const data = JSON.parse(line);
        if (!data || typeof data.ok !== 'boolean') throw new Error('Invalid worker response envelope');
        if (!this.pending) throw new Error('Unexpected worker response');
        const { resolve, cleanup } = this.pending;
        this.pending = null; cleanup(); resolve(data);
      } catch (e) { this.fail(e); }
    });
  }
  fail(e) {
    this.failed ??= e;
    if (this.pending) { this.pending.cleanup(); this.pending.reject(this.failed); this.pending = null; }
    this.child?.kill();
  }
  // v3.11: a cancelled or timed-out call no longer kills the worker (that lost every open document id and left drawings half made).
  // The caller gets an error at once, the operation keeps running in SolidWorks, the next calls wait behind it, and its real
  // response is kept in this.late (server.mjs hands it to the next tool response as late_results). Only a worker silent for
  // hardTimeoutMs is killed.
  call(operation, args, { signal } = {}) {
    const request = JSON.stringify({ operation, arguments: args }) + '\n';
    let t0 = 0, onStart = () => {};
    const run = this.chain.then(() => {
      if (signal?.aborted) throw new Error('Request cancelled before CAD execution');
      this.start();
      t0 = performance.now(); onStart();
      return new Promise((resolve, reject) => {
        const hard = setTimeout(() => this.fail(new Error(`CAD worker silent for ${Math.round(this.hardTimeoutMs / 60000)} min; restarted. Outcome UNKNOWN; inspect SolidWorks before retrying.`)), this.hardTimeoutMs);
        this.pending = { resolve, reject, cleanup: () => clearTimeout(hard) };
        this.child.stdin.write(request, e => { if (e) this.fail(e); });
      }).then(r => {
        // v3.8 profiling: [operation, ms seen here, ms inside the worker, ms until the document code] (last 500 calls)
        (this.profile ??= []).push([operation, Math.round(performance.now() - t0), r?.worker_ms ?? null, r?.pre_ms ?? null, r?.pre_split ?? null]);
        if (this.profile.length > 500) this.profile.shift();
        return r;
      });
    });
    this.chain = run.catch(() => {});
    return new Promise((resolve, reject) => {
      let settled = false, detached = null, started = false, timer = null;
      const leave = why => {
        if (settled) return; settled = true; detached = why; cleanup();
        reject(new Error(`CAD request ${why}; it keeps running in SolidWorks (not killed, document ids stay valid). Outcome UNKNOWN until it finishes: the next call waits for it and reports its result as late_results.`));
      };
      // a request still waiting in the queue is simply not run (run checks signal.aborted when its turn comes)
      const abort = () => { if (started) leave('cancelled'); };
      // the timeout counts from the moment SolidWorks starts this request, not while it waits behind others
      onStart = () => { started = true; if (!settled) timer = setTimeout(() => leave(`still running after ${Math.round(this.timeoutMs / 1000)} s`), this.timeoutMs); };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      run.then(r => {
        if (!settled) { settled = true; cleanup(); resolve(r); return; }
        if (detached !== 'queued') this.late.push({ operation, reason: detached, finished_after_s: Math.round((performance.now() - t0) / 1000), response: r });
      }, e => {
        if (!settled) { settled = true; cleanup(); reject(e); return; }
        if (detached !== 'queued') this.late.push({ operation, reason: detached, error: e.message });
      });
    });
  }
  takeLate() { const l = this.late; this.late = []; return l; }
  close() { this.fail(new Error('MCP worker channel closed; do not retry an interrupted edit without inspecting its outcome.')); }
}
