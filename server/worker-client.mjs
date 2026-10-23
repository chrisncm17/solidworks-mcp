import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class WorkerClient {
  constructor({ timeoutMs = 150000, executable = fileURLToPath(new URL('./Worker-equations.exe', import.meta.url)), args = [] } = {}) {
    this.timeoutMs = timeoutMs;
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
  call(operation, args, { signal } = {}) {
    const request = JSON.stringify({ operation, arguments: args }) + '\n';
    const task = this.chain.then(() => {
      if (signal?.aborted) throw new Error('Request cancelled before CAD execution');
      this.start();
      const t0 = performance.now();
      return new Promise((resolve, reject) => {
        const abort = () => this.fail(new Error('CAD request cancelled during execution. Outcome UNKNOWN; inspect before retrying.'));
        const timer = setTimeout(() => {
          this.fail(new Error('CAD operation timed out. Its outcome is UNKNOWN; do not retry edits blindly. Inspect SolidWorks before starting a new MCP session.'));
        }, this.timeoutMs);
        this.pending = { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
        signal?.addEventListener('abort', abort, { once: true });
        this.child.stdin.write(request, e => { if (e) this.fail(e); });
      }).then(r => {
        // v3.8 profiling: [operation, ms seen here, ms inside the worker, ms until the document code] (last 500 calls)
        (this.profile ??= []).push([operation, Math.round(performance.now() - t0), r?.worker_ms ?? null, r?.pre_ms ?? null, r?.pre_split ?? null]);
        if (this.profile.length > 500) this.profile.shift();
        return r;
      });
    });
    this.chain = task.catch(() => {});
    return task;
  }
  close() { this.fail(new Error('MCP worker channel closed; do not retry an interrupted edit without inspecting its outcome.')); }
}
