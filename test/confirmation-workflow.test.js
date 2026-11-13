import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmissionGuard, submitMappingEntries } from '../src/confirmation-workflow.js';

test('rapid confirmation attempts run only one submission and allow retry after failure', async () => {
  const guard = createSubmissionGuard();
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const first = guard(async () => { calls += 1; await pending; throw new Error('FOBE-API request failed (503)'); });
  const second = await guard(async () => { calls += 1; });
  assert.deepEqual(second, { skipped: true });
  assert.equal(calls, 1);
  release();
  await assert.rejects(first, /503/);
  const retry = await guard(async () => { calls += 1; });
  assert.equal(retry.skipped, false);
  assert.equal(calls, 2);
});

test('rapid unmap attempts issue only one delete request', async () => {
  const guard = createSubmissionGuard();
  let deletes = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const first = guard(async () => { deletes += 1; await pending; });
  const second = await guard(async () => { deletes += 1; });
  assert.deepEqual(second, { skipped: true });
  assert.equal(deletes, 1);
  release();
  await first;
  assert.equal(deletes, 1);
});

test('single confirmation submits exactly one mapping', async () => {
  let calls = 0;
  const result = await submitMappingEntries([{ id: 'one' }], async () => { calls += 1; });
  assert.equal(calls, 1);
  assert.deepEqual(result, { submitted: 1, error: null });
});

test('batch confirmation submits each intended mapping once', async () => {
  const submitted = [];
  const result = await submitMappingEntries([{ id: 'one' }, { id: 'two' }], async entry => submitted.push(entry.id));
  assert.deepEqual(submitted, ['one', 'two']);
  assert.deepEqual(result, { submitted: 2, error: null });
});

test('a failed mapping request stops the batch without retrying', async () => {
  const submitted = [];
  const unavailable = new Error('FOBE-API request failed (503)');
  const result = await submitMappingEntries([{ id: 'one' }, { id: 'two' }], async entry => {
    submitted.push(entry.id);
    throw unavailable;
  });
  assert.deepEqual(submitted, ['one']);
  assert.equal(result.submitted, 0);
  assert.equal(result.error, unavailable);
});

test('a partial batch failure preserves earlier successful confirmations', async () => {
  const submitted = [];
  const unavailable = new Error('FOBE-API request failed (503)');
  const result = await submitMappingEntries([{ id: 'one' }, { id: 'two' }, { id: 'three' }], async entry => {
    submitted.push(entry.id);
    if (entry.id === 'two') throw unavailable;
  });
  assert.deepEqual(submitted, ['one', 'two']);
  assert.equal(result.submitted, 1);
  assert.equal(result.error, unavailable);
});
