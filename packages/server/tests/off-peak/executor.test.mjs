import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareIdleExecution, WebOffPeakPolicyError } from '../../src/off-peak/executor.ts';

function fixture(taskPatch = {}, overrides = {}) {
  let callback; const calls = [];
  const task = {
    offPeakTaskId: 'offpeak-test', workspacePath: '/srv/project', status: 'queued',
    prompt: 'Original task', permissionMode: 'build', serverTicketId: 'real-ticket', schedulable: true,
    modelSelection: { providerId: 'account:bigmodel-offpeak-idle-plan', modelId: 'allowed', options: { reasoningLevel: 'high' } },
    ...taskPatch,
  };
  const deps = {
    validateSelection: async () => true,
    buildRequestAuth: async ticket => ({ apiKey: 'login-jwt', headers: {
      Authorization: 'Bearer login-jwt', 'X-Coding-Plan-Api-Key': 'plan-key', 'X-Off-Peak-Ticket-ID': ticket,
    } }),
    assertWorkspace: async () => {},
    isTicketExpired: message => message === 'ticket_expired',
    tasks: {
      async createTask(p) { calls.push(['create', p]); return { taskId: 'new-session', traceId: 'new-input' }; },
      async resumeTask(p) { calls.push(['resume', p]); },
      async setConfigOption(p) { calls.push(['config', p]); },
      async listDeletedTaskIds() { return []; },
      async listTasks() { return []; },
      onTerminal(id, listener) { calls.push(['subscribe', id]); callback = listener; return { dispose() { calls.push(['dispose']); } }; },
      async sendPrompt(p) { calls.push(['send', p]); },
      async stopGeneration(p) { calls.push(['stop', p]); },
    },
    ...overrides,
  };
  return { task, deps, calls, emit: event => callback?.(event) };
}

test('idle request preserves all accounting boundaries and defaults to approval mode', async t => {
  const f = fixture(); const ex = await prepareIdleExecution(f.deps, f.task); t.after(() => ex.dispose());
  assert(!f.calls.some(([name]) => name === 'send')); await ex.submit();
  const create = f.calls.find(([name]) => name === 'create')[1];
  assert.equal(create.deferPersistenceUntilFirstPrompt, true);
  assert.equal(create.mode, 'build'); assert(!('modelSelection' in create));
  const sent = f.calls.find(([name]) => name === 'send')[1];
  assert.equal(sent.modelSelection.providerId, 'account:bigmodel-offpeak-idle-plan');
  assert.equal(sent.modelExecution.requestAuth.headers['X-Off-Peak-Ticket-ID'], 'real-ticket');
  assert.equal(sent.modelExecution.selectionScope, 'execution');
  assert.equal(sent.modelExecution.memoryExtraction, 'skip');
  assert.deepEqual(sent.modelExecution.subagents, { foregroundModel: 'submission', background: 'deny' });
  assert.deepEqual(sent.toolDenylist, ['CronCreate', 'OffPeakCreate']);
  assert.equal(sent.offPeakTaskId, 'offpeak-test'); assert.equal(sent.offPeakRunType, 'init');
  assert.equal(sent.content, 'Original task');
});

for (const [name, patch] of [
  ['missing ticket', { serverTicketId: '' }],
  ['ordinary paid provider', { modelSelection: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'allowed' } }],
  ['remote workspace', { workspaceIdentity: 'ssh://elsewhere' }],
  ['invalid permission mode', { permissionMode: 'approve-everything' }],
]) {
  test(`rejects ${name} before creating a session`, async () => {
    const f = fixture(patch); await assert.rejects(prepareIdleExecution(f.deps, f.task), WebOffPeakPolicyError);
    assert.equal(f.calls.length, 0);
  });
}

test('official model validation cannot be bypassed by a correct-looking provider id', async () => {
  const f = fixture({}, { validateSelection: async () => false });
  await assert.rejects(prepareIdleExecution(f.deps, f.task), /idle_model_unavailable/); assert.equal(f.calls.length, 0);
});

test('mismatched or incomplete ticket authentication fails closed', async () => {
  const f = fixture({}, { buildRequestAuth: async () => ({ apiKey: 'key', headers: { Authorization: 'Bearer x', 'X-Coding-Plan-Api-Key': 'key', 'X-Off-Peak-Ticket-ID': 'different' } }) });
  await assert.rejects(prepareIdleExecution(f.deps, f.task), /incomplete_idle_request_auth/); assert.equal(f.calls.length, 0);
});

test('authentication header matching is case insensitive', async t => {
  const f = fixture({}, { buildRequestAuth: async () => ({ apiKey: 'key', headers: { authorization: 'Bearer x', 'x-coding-plan-api-key': 'key', 'x-off-peak-ticket-id': 'real-ticket' } }) });
  const ex = await prepareIdleExecution(f.deps, f.task); t.after(() => ex.dispose()); await ex.submit();
  assert(f.calls.some(([name]) => name === 'send'));
});

test('resume reuses the session and does not resend the original prompt', async t => {
  const f = fixture({ conversationId: 'saved-session' }); const ex = await prepareIdleExecution(f.deps, f.task); t.after(() => ex.dispose());
  await ex.submit(); assert.equal(f.calls.filter(([name]) => name === 'create').length, 0);
  const sent = f.calls.find(([name]) => name === 'send')[1]; assert.equal(sent.taskId, 'saved-session');
  assert.equal(sent.offPeakRunType, 'resume'); assert.match(sent.content, /Do not start over/); assert.notEqual(sent.content, f.task.prompt);
});

test('bound first run keeps the original prompt and uses a distinct input id', async t => {
  const f = fixture({ sessionId: 'bound-session' }); const ex = await prepareIdleExecution(f.deps, f.task); t.after(() => ex.dispose());
  await ex.submit(); const sent = f.calls.find(([name]) => name === 'send')[1];
  assert.equal(sent.content, f.task.prompt); assert.equal(sent.offPeakRunType, 'init'); assert.match(sent.traceId, /^offpeak-test:bound:/);
});

test('busy bound session is rejected before changing mode', async () => {
  const f = fixture({ sessionId: 'busy' }); f.deps.tasks.listTasks = async () => [{ taskId: 'busy', status: 'running' }];
  await assert.rejects(prepareIdleExecution(f.deps, f.task), /busy/); assert(!f.calls.some(([name]) => name === 'config'));
});

test('deleted bound session is a permanent failure', async () => {
  const f = fixture({ sessionId: 'gone' }); f.deps.tasks.listDeletedTaskIds = async () => ['gone'];
  await assert.rejects(prepareIdleExecution(f.deps, f.task), WebOffPeakPolicyError);
});

test('unrelated terminal events cannot settle the run; 3102 is recognized', async t => {
  const f = fixture(); const ex = await prepareIdleExecution(f.deps, f.task); t.after(() => ex.dispose());
  f.emit({ inputId: 'someone-else', outcome: 'succeeded' }); assert.equal(ex.peekOutcome(), undefined);
  f.emit({ inputId: ex.inputId, outcome: 'failed', error: 'ticket_expired' });
  assert.deepEqual(await ex.finished, { outcome: 'failed', ticketExpired: true });
});

test('disposed subscriptions ignore late events and reject subsequent sends', async () => {
  const f = fixture(); const ex = await prepareIdleExecution(f.deps, f.task); ex.dispose();
  f.emit({ inputId: ex.inputId, outcome: 'succeeded' }); assert.equal(ex.peekOutcome(), undefined);
  await assert.rejects(ex.submit(), /disposed/); assert(!f.calls.some(([name]) => name === 'send'));
});

test('a run can only be submitted once', async t => {
  const f = fixture(); const ex = await prepareIdleExecution(f.deps, f.task); t.after(() => ex.dispose()); await ex.submit();
  await assert.rejects(ex.submit(), /duplicate/); assert.equal(f.calls.filter(([name]) => name === 'send').length, 1);
});

test('stop carries the exact run id so it cannot stop an unrelated later user turn', async t => {
  const f = fixture(); const ex = await prepareIdleExecution(f.deps, f.task); t.after(() => ex.dispose()); await ex.stop();
  const stopped = f.calls.find(([name]) => name === 'stop')[1]; assert.equal(stopped.runId, ex.inputId);
});
