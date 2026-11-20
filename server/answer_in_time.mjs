// v3.18 the desktop app gives a call 60 s. Past that it says "Request timed out" and another server takes over: the worker goes
// with this one, every document id is lost and a job of several steps stays half done (organize left a sheet with 1 dimension of
// 23, between deleting them and putting them back). So no call gets there: at ANSWER_WITHIN_MS it answers running:true and keeps
// going as a tracked job (other calls wait for it); what it ends with goes to `late`, which the next response carries.
import { trackJob, backgroundJobs } from './assembly_build.mjs';

export const ANSWER_WITHIN_MS = 50000;
const parsed = out => { const text = out.content?.[0]?.text; try { return JSON.parse(text); } catch { return { ok: !out.isError, error: text }; } };
export function answerInTime(job, { tool, late, signal, withinMs = ANSWER_WITHIN_MS }) {
  const t0 = performance.now();
  let detached = false, timer;
  const running = new Promise(resolve => {
    timer = setTimeout(() => {
      if (signal?.aborted) return;   // the client cancelled it and will not read an answer: the job reports by itself
      const behind = backgroundJobs().filter(j => !j.done).map(j => j.label), label = `${tool}:${Date.now()}`;
      detached = true; trackJob(label, job, { forget: true });
      resolve({ content: [{ type: 'text', text: JSON.stringify({ ok: true, running: true, tool, running_s: Math.round(withinMs / 1000), ...(behind.length ? { waiting_for: behind } : {}), note: 'Sigue trabajando en SolidWorks: no la repitas ni guardes todavia. Su resultado llega como late_results en la siguiente respuesta que termine; las llamadas a SolidWorks esperan a que acabe y sw_exam_ready responde sin esperar (background_jobs).' }) }] });
    }, withinMs);
  });
  const finished = response => { clearTimeout(timer); if (detached) late().push({ operation: tool, reason: 'answered running:true', finished_after_s: Math.round((performance.now() - t0) / 1000), ...response }); };
  job.then(out => finished({ response: parsed(out) }), e => finished({ error: e.message }));
  return Promise.race([job, running]);
}
