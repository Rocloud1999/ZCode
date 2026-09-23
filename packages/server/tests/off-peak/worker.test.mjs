import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { WebOffPeakWorker } from '../../src/off-peak/worker.ts';

const copy = (v) => structuredClone(v);
const task = (id = 'one', patch = {}) => ({
  offPeakTaskId: id, status: 'queued', workspacePath: '/srv/project',
  serverTicketId: 'ticket-' + id, modelSelection: { providerId: 'account:bigmodel-offpeak-idle-plan', modelId: 'allowed' },
  permissionMode: 'build', prompt: 'Review without modifying files', schedulable: true, ...patch,
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 6; i++) await turn(); };

function harness(rows = [task()], options = {}) {
  const data = new Map(rows.map(t => [t.offPeakTaskId, copy(t)]));
  const claims = new Set();
  const records = new Map((options.records ?? []).map(r => [r.taskId, copy(r)]));
  const events = [], executions = [];
  let now = 1_000, enabled = true;
  const repo = {
    async get(id) { return copy(data.get(id) ?? null); },
    async listNonTerminal() { return [...data.values()].filter(t => !['completed', 'failed', 'cancelled'].includes(t.status)).map(copy); },
    async claimDue() {
      const due = [...data.values()].filter(t => t.status === 'queued' && t.schedulable && !claims.has(t.offPeakTaskId));
      due.forEach(t => claims.add(t.offPeakTaskId));
      events.push('claim'); return due.map(copy);
    },
    async releaseClaim(id) { claims.delete(id); events.push('release:' + id); },
    async markRunning(id, params) {
      const t = data.get(id); if (!t || t.status !== 'queued') return null;
      Object.assign(t, params, { status: 'running' }); claims.delete(id); events.push('running:' + id); return copy(t);
    },
    async markTerminal(id, params) {
      const t = data.get(id); if (!t || ['completed', 'failed', 'cancelled'].includes(t.status)) return null;
      Object.assign(t, params); claims.delete(id); events.push('terminal:' + id); return copy(t);
    },
    async recoverInterrupted() {
      let count = 0; for (const t of data.values()) if (t.status === 'running') { t.status = 'queued'; count++; }
      events.push('recover'); return count;
    },
  };
  const journal = {
    async list() { return [...records.values()].map(copy); },
    async put(r) { records.set(r.taskId, copy(r)); events.push('journal:' + r.stage); },
    async remove(id) { records.delete(id); events.push('remove:' + id); },
  };
  function execution(t) {
    const done = deferred(); let result;
    const ex = {
      conversationId: t.conversationId ?? t.sessionId ?? 'session-' + t.offPeakTaskId,
      sessionId: t.conversationId ?? t.sessionId ?? 'session-' + t.offPeakTaskId,
      inputId: 'input-' + t.offPeakTaskId, finished: done.promise, submits: 0, stops: 0, disposed: false,
      peekOutcome: () => result,
      emit(outcome = 'succeeded', ticketExpired = false) { if (result) return; result = { outcome, ticketExpired }; done.resolve(result); },
      async submit() { ex.submits++; events.push('submit:' + t.offPeakTaskId); await options.submit?.(ex, t); },
      async stop() { ex.stops++; ex.emit('stopped'); },
      dispose() { ex.disposed = true; },
    };
    executions.push(ex); return ex;
  }
  const deps = {
    repo, journal, now: () => now, isEnabled: async () => enabled,
    prepare: async t => { if (options.prepare) await options.prepare(t); return execution(t); },
    onTicketExpired: async id => { events.push('expired:' + id); const t = data.get(id); if (t?.status === 'running') Object.assign(t, { status: 'queued', schedulable: false }); },
    isPermanent: error => error?.failureKind === 'permanent',
    log: event => events.push('log:' + event),
  };
  const worker = new WebOffPeakWorker(deps);
  return { data, claims, records, events, executions, deps, worker, setEnabled: v => { enabled = v; }, advance: ms => { now += ms; } };
}
const start = h => h.worker.start({ timers: false });
const record = (stage, patch = {}) => ({ version: 1, taskId: 'one', sessionId: 'saved', inputId: 'saved-input', stage, ...patch });

test('disabled official gate never claims or sends', async t => {
  const h = harness(); t.after(() => h.worker.stop()); await start(h); h.setEnabled(false); await h.worker.tick();
  assert.equal(h.executions.length, 0); assert.equal(h.claims.size, 0); assert(!h.events.includes('claim'));
});

test('official config request failure waits; does not dispatch or fail over', async t => {
  const h = harness(); t.after(() => h.worker.stop()); h.deps.isEnabled = async () => { throw Error('offline'); };
  await start(h); await h.worker.tick(); assert.equal(h.executions.length, 0); assert.equal(h.worker.getStatus().state, 'ready');
});

test('journals and session binding precede submit; success finalizes without browser', async t => {
  const h = harness(); t.after(() => h.worker.stop()); await start(h); await h.worker.tick();
  const order = h.events;
  assert(order.indexOf('journal:prepared') < order.indexOf('running:one'));
  assert(order.indexOf('running:one') < order.indexOf('journal:submitting'));
  assert(order.indexOf('journal:submitting') < order.indexOf('submit:one'));
  assert.equal(h.data.get('one').conversationId, 'session-one');
  h.executions[0].emit(); await drain(); assert.equal(h.data.get('one').status, 'completed'); assert.equal(h.records.size, 0);
});

test('terminal event before send ACK is buffered and not overwritten by running', async t => {
  const h = harness(undefined, { submit: async ex => { ex.emit(); await turn(); } });
  t.after(() => h.worker.stop()); await start(h); await h.worker.tick(); await drain();
  assert.equal(h.data.get('one').status, 'completed'); assert.equal(h.executions[0].submits, 1);
});

test('single-flight concurrent ticks and only one active execution', async t => {
  const barrier = deferred(); const h = harness([task(), task('two')], { prepare: () => barrier.promise });
  t.after(() => h.worker.stop()); await start(h);
  const a = h.worker.tick(), b = h.worker.tick(); assert.equal(a, b); barrier.resolve(); await Promise.all([a, b]);
  await h.worker.tick(); assert.equal(h.executions.length, 1); assert(!h.claims.has('two'));
  h.executions[0].emit(); await drain(); await h.worker.tick(); assert.equal(h.executions.length, 2);
});

test('transient prepare failure uses bounded local backoff', async t => {
  let attempts = 0; const h = harness(undefined, { prepare: () => { attempts++; throw Error('busy'); } });
  t.after(() => h.worker.stop()); await start(h); await h.worker.tick(); await h.worker.tick(); assert.equal(attempts, 1);
  h.advance(30_000); await h.worker.tick(); assert.equal(attempts, 2); assert.equal(h.data.get('one').status, 'queued');
});

test('permanent preparation failure is terminal, never retried', async t => {
  const h = harness(undefined, { prepare: () => { throw Object.assign(Error('invalid'), { failureKind: 'permanent' }); } });
  t.after(() => h.worker.stop()); await start(h); await h.worker.tick(); await h.worker.tick();
  assert.equal(h.data.get('one').status, 'failed'); assert.equal(h.executions.length, 0);
});

test('ambiguous failed send is stopped and failed, not released for duplicate execution', async t => {
  const h = harness(undefined, { submit: () => { throw Error('ACK lost'); } }); t.after(() => h.worker.stop());
  await start(h); await h.worker.tick(); await h.worker.tick();
  assert.equal(h.executions.length, 1); assert.equal(h.executions[0].stops, 1);
  assert.equal(h.data.get('one').status, 'failed'); assert.match(h.data.get('one').failureReason, /admission_uncertain/);
});

test('known outcome survives an ACK failure', async t => {
  const h = harness(undefined, { submit: ex => { ex.emit(); throw Error('ACK lost'); } }); t.after(() => h.worker.stop());
  await start(h); await h.worker.tick(); assert.equal(h.data.get('one').status, 'completed');
});

test('3102 outcome requeues existing session via shared service', async t => {
  const h = harness(); t.after(() => h.worker.stop()); await start(h); await h.worker.tick();
  h.executions[0].emit('failed', true); await drain();
  assert.equal(h.data.get('one').status, 'queued'); assert.equal(h.data.get('one').conversationId, 'session-one');
  assert(h.events.includes('expired:one')); await h.worker.tick(); assert.equal(h.executions.length, 1);
});

test('cancellation during preparation prevents a model request', async t => {
  const gate = deferred(); const h = harness(undefined, { prepare: () => gate.promise }); t.after(() => h.worker.stop());
  await start(h); const work = h.worker.tick(); await drain(); h.data.get('one').status = 'cancelled'; gate.resolve(); await work;
  assert.equal(h.executions[0].submits, 0); assert.equal(h.data.get('one').status, 'cancelled');
});

test('editing claimed payload invalidates the prepared snapshot', async t => {
  const gate = deferred(); const h = harness(undefined, { prepare: () => gate.promise }); t.after(() => h.worker.stop());
  await start(h); const work = h.worker.tick(); await drain(); h.data.get('one').prompt = 'different'; gate.resolve(); await work;
  assert.equal(h.executions[0].submits, 0); assert.equal(h.data.get('one').status, 'queued');
});

test('running cancellation stops the owned Agent and preserves terminal status', async t => {
  const h = harness(); t.after(() => h.worker.stop()); await start(h); await h.worker.tick();
  h.data.get('one').status = 'cancelled'; await h.worker.tick(); await drain();
  assert.equal(h.executions[0].stops, 1); assert.equal(h.data.get('one').status, 'cancelled');
});

test('accepted interrupted task recovers and reuses saved session', async t => {
  const h = harness([task('one', { status: 'running', conversationId: 'saved', sessionId: 'saved' })], { records: [record('accepted')] });
  t.after(() => h.worker.stop()); await start(h); assert.equal(h.data.get('one').status, 'queued');
  await h.worker.tick(); assert.equal(h.executions[0].sessionId, 'saved');
});

test('submitting/ACK crash window is flagged for review, never automatically replayed', async t => {
  const h = harness([task('one', { status: 'running', conversationId: 'saved' })], { records: [record('submitting')] });
  t.after(() => h.worker.stop()); await start(h); await h.worker.tick();
  assert.equal(h.data.get('one').status, 'failed'); assert.match(h.data.get('one').failureReason, /uncertain/); assert.equal(h.executions.length, 0);
});

test('terminal journal is replayed without another model request', async t => {
  const h = harness([task('one', { status: 'running', conversationId: 'saved' })], { records: [record('terminal', { outcome: { outcome: 'succeeded', ticketExpired: false } })] });
  t.after(() => h.worker.stop()); await start(h); await h.worker.tick(); assert.equal(h.data.get('one').status, 'completed'); assert.equal(h.executions.length, 0);
});

test('terminal journal cannot revive a task already cancelled', async t => {
  const h = harness([task('one', { status: 'cancelled', conversationId: 'saved' })], { records: [record('terminal', { outcome: { outcome: 'succeeded', ticketExpired: false } })] });
  t.after(() => h.worker.stop()); await start(h); assert.equal(h.data.get('one').status, 'cancelled'); assert.equal(h.records.size, 0);
});

test('untracked running rows require review rather than stealing another host execution', async t => {
  const h = harness([task('one', { status: 'running' })]); t.after(() => h.worker.stop()); await start(h); await h.worker.tick();
  assert.equal(h.data.get('one').status, 'failed'); assert.equal(h.executions.length, 0);
});

test('journal write failure halts dispatch before submit', async t => {
  const h = harness(); t.after(() => h.worker.stop()); h.deps.journal.put = async () => { throw Error('disk full'); };
  await start(h); await h.worker.tick(); assert.equal(h.worker.getStatus().state, 'faulted'); assert.equal(h.executions[0].submits, 0);
});

test('shutdown preserves accepted run for recovery, not user-cancelled accounting', async () => {
  const h = harness(); await start(h); await h.worker.tick(); await h.worker.stop(); await drain();
  assert.equal(h.executions[0].stops, 1); assert.equal(h.data.get('one').status, 'running'); assert.equal(h.records.get('one').stage, 'accepted');
  await h.worker.tick(); assert.equal(h.executions.length, 1);
});

test('stop during initial recovery waits for storage work and prevents startup', async () => {
  const h = harness(); const gate = deferred(); h.deps.journal.list = () => gate.promise;
  const starting = start(h); let stopped = false; const stopping = h.worker.stop().then(() => { stopped = true; });
  await drain(); assert.equal(stopped, false); gate.resolve([]); await Promise.all([starting, stopping]);
  await h.worker.tick(); assert.equal(h.executions.length, 0);
});

test('stop requested during pre-submit journal write prevents send', async () => {
  const h = harness(); const gate = deferred(); const put = h.deps.journal.put;
  h.deps.journal.put = async r => { await put(r); if (r.stage === 'submitting') await gate.promise; };
  await start(h); const ticking = h.worker.tick(); await drain(); const stopping = h.worker.stop(); gate.resolve(); await Promise.all([ticking, stopping]);
  assert.equal(h.executions[0].submits, 0);
});


test('known success racing shutdown is persisted instead of resumed on restart', async () => {
  const h = harness(); await start(h); await h.worker.tick();
  h.executions[0].emit('succeeded');
  await h.worker.stop(); await drain();
  assert.equal(h.data.get('one').status, 'completed');
  assert.equal(h.records.size, 0);
});

test('own shutdown stop preserves accepted run for same-session recovery', async () => {
  const h = harness(); await start(h); await h.worker.tick();
  await h.worker.stop(); await drain();
  assert.equal(h.data.get('one').status, 'running');
  assert.equal(h.records.get('one').stage, 'accepted');
  assert.equal(h.executions[0].stops, 1);
});
