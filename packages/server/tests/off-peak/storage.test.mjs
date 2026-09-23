import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createFileJournal } from '../../src/off-peak/journal.ts';
import { acquireWebOffPeakLease } from '../../src/off-peak/lease.ts';
import { readWebOffPeakOptions, createWorkspaceGuard, ensureDedicatedDataDirectory } from '../../src/off-peak/configuration.ts';

async function temporary(t) { const path = await mkdtemp(join(tmpdir(), 'zcode-web-offpeak-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const record = { version: 1, taskId: 'offpeak-test', sessionId: 'session', inputId: 'input', stage: 'accepted' };
const env = { ZCODE_WEB_OFFPEAK_ENABLED: '1', ZCODE_DATA_BASE_DIR: '/var/lib/zcode-test', ZCODE_SERVER_WORKSPACE: '/srv/project', ZCODE_SERVER_AUTH_TOKEN: 'a'.repeat(40) };

test('feature remains off by default and does not alter ordinary Web startup', () => {
  assert.equal(readWebOffPeakOptions({}), undefined); assert.equal(readWebOffPeakOptions({ ZCODE_WEB_OFFPEAK_ENABLED: '0' }), undefined);
});

test('requires explicit dedicated storage, workspace, token and valid switch', () => {
  assert.deepEqual(readWebOffPeakOptions(env), { dataDirectory: '/var/lib/zcode-test', workspaceRoot: '/srv/project' });
  for (const patch of [
    { ZCODE_DATA_BASE_DIR: '' }, { ZCODE_DATA_BASE_DIR: homedir() }, { ZCODE_DATA_BASE_DIR: 'relative' },
    { ZCODE_SERVER_WORKSPACE: '' }, { ZCODE_SERVER_AUTH_TOKEN: '' },
    { ZCODE_SERVER_AUTH_TOKEN: 'REPLACE_WITH_A_RANDOM_PRIVATE_TOKEN' },
    { ZCODE_WEB_OFFPEAK_ENABLED: 'true' },
  ]) assert.throws(() => readWebOffPeakOptions({ ...env, ...patch }));
});

test('production worker rejects Mock rather than pretending it is free', () => {
  assert.throws(() => readWebOffPeakOptions({ ...env, ZCODE_OFFPEAK_MOCK: '1' }), /Mock/);
});

test('workspace guard accepts descendants and rejects symlink escape', async t => {
  const root = await temporary(t); const project = join(root, 'project'); const sibling = join(root, 'other');
  await mkdir(project); await mkdir(sibling); await mkdir(join(project, 'sub')); await symlink(sibling, join(project, 'escape'));
  const guard = await createWorkspaceGuard(project); await guard(project); await guard(join(project, 'sub'));
  await assert.rejects(guard(sibling), /outside_allowed/); await assert.rejects(guard(join(project, 'escape')), /outside_allowed/);
});

test('journal persists allowed metadata only with owner-only permissions', async t => {
  const dir = await temporary(t); const journal = createFileJournal(dir);
  await journal.put({ ...record, requestAuth: 'DO-NOT-PERSIST', prompt: 'DO-NOT-PERSIST' });
  assert.deepEqual(await journal.list(), [record]); const files = await readdir(dir); assert.equal(files.length, 1);
  assert.equal((await stat(join(dir, files[0]))).mode & 0o777, 0o600);
  assert(!(await readFile(join(dir, files[0]), 'utf8')).includes('DO-NOT-PERSIST'));
  await journal.remove(record.taskId); await journal.remove(record.taskId); assert.deepEqual(await journal.list(), []);
});

test('journal update is replace-based and can be read by a new process instance', async t => {
  const dir = await temporary(t); const a = createFileJournal(dir); await a.put(record);
  const terminal = { ...record, stage: 'terminal', outcome: { outcome: 'failed', ticketExpired: false, failureCode: 'admission_uncertain' } };
  await a.put(terminal); assert.deepEqual(await createFileJournal(dir).list(), [terminal]);
  assert.equal((await readdir(dir)).length, 1);
});

test('corrupt journal fails closed instead of silently re-executing', async t => {
  const dir = await temporary(t); const j = createFileJournal(dir); await j.put(record);
  const file = (await readdir(dir))[0]; await writeFile(join(dir, file), '{broken');
  await assert.rejects(j.list());
});

test('journal rejects malformed terminal outcomes and hashes task ids into safe filenames', async t => {
  const dir = await temporary(t); const j = createFileJournal(dir);
  await assert.rejects(j.put({ ...record, stage: 'terminal' }), /invalid/);
  await j.put({ ...record, taskId: '../escape' }); const [name] = await readdir(dir); assert.match(name, /^[a-f0-9]{64}\.json$/);
});

test('Linux lease excludes a second worker and can be reacquired after close', { skip: process.platform !== 'linux' }, async t => {
  const dir = await temporary(t); const first = await acquireWebOffPeakLease(dir);
  try { await assert.rejects(acquireWebOffPeakLease(dir), /already_running/); }
  finally { await first.close(); }
  const next = await acquireWebOffPeakLease(dir); await next.close(); await next.close();
});

test('different spelling through a symlink does not acquire a second lease', { skip: process.platform !== 'linux' }, async t => {
  const dir = await temporary(t); const real = join(dir, 'real'); const alias = join(dir, 'alias');
  await mkdir(real); await symlink(real, alias); const first = await acquireWebOffPeakLease(real);
  try { await assert.rejects(acquireWebOffPeakLease(alias), /already_running/); }
  finally { await first.close(); }
});


test('data directory rejects HOME even when reached through a symlink', async t => {
  const dir = await temporary(t); const alias = join(dir, 'home-alias');
  await symlink(homedir(), alias);
  await assert.rejects(ensureDedicatedDataDirectory(alias), /not_dedicated/);
  assert.equal(await ensureDedicatedDataDirectory(dir), await import('node:fs/promises').then(fs => fs.realpath(dir)));
});

test('workspace must be a directory, not merely an existing path', async t => {
  const dir = await temporary(t); const file = join(dir, 'file'); await writeFile(file, 'x');
  await assert.rejects(createWorkspaceGuard(file), /not_directory/);
  const guard = await createWorkspaceGuard(dir); await assert.rejects(guard(file), /not_directory/);
});
