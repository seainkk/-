import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const segmentId = 'kitchens_segment_123456', bindingId = 'bound_campaign_123456789';
const campaignId = '7948c67a-48ab-42df-be53-9e8d3442a6a7';
const request = { segmentId, bindingId, targetKind: 'companies', requestId: 'first-transfer' };
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(size) {
  const env = vm.createContext({ console });
  for (const file of ['Code.gs', 'SegmentActions.gs', 'Coldy.gs', 'ColdyCampaigns.gs', 'ColdyRecipientData.gs', 'ColdyRecipientImport.gs']) {
    vm.runInContext(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), env, { filename: file });
  }
  const values = new Map(), files = new Map(), rows = new Set();
  const context = { rootId: 'root_registry_123456', properties: {
    getProperty: key => values.get(key) ?? null, setProperty: (key, value) => values.set(key, value),
    deleteProperty: key => values.delete(key)
  } };
  const binding = { id: bindingId, segmentId, campaignId, revision: 1 };
  const calls = { pages: [], writes: [], plans: [], target: 0 };
  const faults = { shortPage: false, dropAck: false, changeRevision: false };
  const target = { fileId: 'companies_master_123456', sheetId: 17 };
  const cohort = Array.from({length: size}, (_, i) => ({ id: i + 1, campaign_id: campaignId,
    email: 'lead' + (i + 1) + '@example.test', status: 'Sent', amount_sequences_sent: 1,
    reply_text: null, stop_sending: i === 1 }));
  let locked = false;
  Object.assign(env, {
    Utilities: { getUuid: randomUUID },
    digest_: text => createHash('sha256').update(text).digest('base64url'),
    authorize_: () => context, registryProjectId_: () => 'namshield',
    coldyCredentialHash_: () => 'credential_hash_for_fixture',
    coldyCampaignScope_: (ctx, id) => { assert.equal(ctx, context); assert.equal(id, segmentId); },
    coldyCampaignRegistry_: () => ({ bindings: [plain(binding)] }),
    coldyCampaignRead_: () => ({ name: 'Кухни', status: 'Active' }),
    locked_(callback) {
      assert.equal(locked, false);
      locked = true;
      try { return callback(); } finally { locked = false; }
    },
    coldyApi_(_ctx, method, path) {
      assert.equal(locked, false); assert.equal(method, 'GET');
      const url = new URL(path, 'https://example.test');
      assert.equal(url.pathname, '/leads/campaign/' + campaignId);
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      calls.pages.push(offset);
      const items = cohort.slice(offset, offset + limit);
      if (faults.shortPage && offset > 0) items.pop();
      return { total: cohort.length, offset, limit, items };
    },
    coldyLoad_: (_ctx, kind, owner) => files.has(kind + owner) ? plain(files.get(kind + owner)) : null,
    coldySave_(_ctx, kind, owner, data) { files.set(kind + owner, plain(data)); },
    coldyRecipientSheetTarget_() { calls.target++; return plain(target); },
    coldyRecipientSheetWrite_(_ctx, linked, kind, destination, batch, guard, beforeApply) {
      assert.equal(linked.campaignId, campaignId);
      assert.equal(kind, 'companies'); assert.deepEqual(plain(destination), target);
      if (faults.changeRevision) binding.revision++;
      return env.locked_(() => {
        guard();
        const existing = batch.filter(lead => rows.has(lead.email)).length;
        const counts = { appended: batch.length - existing, existing, excluded: batch.filter(lead => lead.doNotSend).length };
        beforeApply(counts);
        calls.plans.push(counts);
        batch.forEach(lead => rows.add(lead.email));
        calls.writes.push(batch.length);
        if (faults.dropAck) {
          faults.dropAck = false;
          env.fail_('COLDY_STORAGE_UNCERTAIN', 'RAW committed before the simulated timeout');
        }
        return { processed: batch.length };
      });
    }
  });
  return { run: (args = {}) => plain(env.syncColdyRecipients_({ ...request, ...args })), calls, faults, rows, binding, files, cohort };
}

test('501 recipients checkpoint on 500, replay the initial request and cursor, and return an old receipt during a new transfer', () => {
  const f = fixture(501);
  const first = f.run();
  assert.equal(first.state, 'processing'); assert.equal(first.processed, 500); assert.equal(first.total, 501);
  assert.equal(first.providerTotal, 501); assert.equal(first.added, 500); assert.equal(first.excluded, 1);
  assert.deepEqual(f.calls.pages, [0, 200, 400]); assert.deepEqual(f.calls.writes, [500]);
  assert.deepEqual(f.run(), first);
  assert.throws(() => f.run({ cursor: 'another_valid_cursor_identifier' }), /COLDY_RECIPIENT_CURSOR/);
  const done = f.run({ cursor: first.nextCursor });
  assert.equal(done.state, 'complete'); assert.equal(done.processed, 501); assert.equal(done.nextCursor, null);
  assert.equal(done.added, 501); assert.equal(done.updated, 0); assert.equal(done.excluded, 1);
  assert.deepEqual(f.run({ cursor: first.nextCursor }), done); assert.deepEqual(f.run(), done);
  assert.deepEqual(f.calls.pages, [0, 200, 400]); assert.deepEqual(f.calls.writes, [500, 1]);
  const newRun = f.run({ requestId: 'second-transfer' });
  assert.equal(newRun.added, 0); assert.equal(newRun.updated, 500);
  assert.deepEqual(f.run(), done); assert.deepEqual(f.run({ cursor: first.nextCursor }), done);
  assert.deepEqual(f.calls.writes, [500, 1, 500]);
  assert.equal(f.run({ requestId: 'second-transfer', cursor: newRun.nextCursor }).updated, 501);
  assert.equal(f.rows.size, 501);
});

test('a lost acknowledgement after RAW writes preserves the original plan and exact counters on retry', () => {
  const f = fixture(3);
  f.rows.add('lead1@example.test'); f.faults.dropAck = true;
  assert.throws(() => f.run(), /COLDY_STORAGE_UNCERTAIN/);
  assert.equal(f.rows.size, 3);
  assert.throws(() => f.run({ requestId: 'different-transfer' }), /COLDY_RECIPIENT_BUSY/);
  const result = f.run();
  assert.deepEqual(f.calls.plans, [{ appended: 2, existing: 1, excluded: 1 }, { appended: 0, existing: 3, excluded: 1 }]);
  assert.deepEqual([result.processed, result.added, result.updated, result.excluded], [3, 2, 1, 1]);
  assert.deepEqual(f.calls.pages, [0]); assert.equal(f.calls.target, 1); assert.equal(f.rows.size, 3);
  assert.deepEqual(f.run(), result); assert.deepEqual(f.calls.writes, [3, 3]);
});

test('a request cannot be reused for another target; a changed binding revision blocks the next write', () => {
  const f = fixture(501);
  const first = f.run();
  assert.throws(() => f.run({ targetKind: 'lpr' }), /REQUEST_REUSED/);
  assert.throws(() => f.run({ targetKind: 'lpr', cursor: first.nextCursor }), /REQUEST_REUSED/);
  f.faults.changeRevision = true;
  assert.throws(() => f.run({ cursor: first.nextCursor }), /SOURCE_CHANGED/);
  assert.deepEqual(f.calls.writes, [500]); assert.equal(f.rows.size, 500);
});

test('short provider pages fail before touching the destination and a truncated stored snapshot cannot write the remainder', () => {
  const f = fixture(501);
  f.faults.shortPage = true;
  assert.throws(() => f.run(), /COLDY_RECIPIENT_LIST_CHANGED/);
  assert.deepEqual(f.calls.writes, []); assert.equal(f.rows.size, 0); assert.equal(f.calls.target, 0);
  f.faults.shortPage = false;
  const first = f.run();
  const saved = [...f.files.entries()].find(([key]) => key.startsWith('recipientsnapshot'))[1];
  saved.items.pop();
  assert.throws(() => f.run({ cursor: first.nextCursor }), /COLDY_STORAGE/);
  assert.deepEqual(f.calls.writes, [500]); assert.equal(f.rows.size, 500);
});

test('empty campaigns produce a complete zero-count receipt without a sheet write', () => {
  const f = fixture(0);
  const done = f.run();
  assert.deepEqual([done.state, done.processed, done.providerTotal, done.total, done.added, done.updated, done.excluded],
    ['complete', 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(f.run(), done); assert.deepEqual(f.calls.pages, [0]); assert.deepEqual(f.calls.writes, []);
});
