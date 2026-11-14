const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { temporaryFolder } = require('./temp.cjs');
const { createUsageBudget, estimateOpenAI } = require('../src/intelligence/usage-budget.cjs');

const model = 'gpt-5.6-terra';
const date = '2026-11-14';
const time = Date.parse(date);
const request = [model, 120, 1, 1024];

test('cost estimates include UTF-8 allowance, framing and the output cap, and unknown prices expire', () => {
  assert.deepEqual(estimateOpenAI(model, Buffer.byteLength('café 🌱'), 3, 64, date), {
    inputAllowance: 458, micros: 1913, checked: date,
  });
  assert.equal(estimateOpenAI('unknown', 120, 1, 1024, date), null);
  assert.equal(estimateOpenAI(model, 120, 1, 1024, '2027-02-12'), null);
});

test('reservations serialize before delivery, reconcile validated usage and keep incomplete usage across restart', async t => {
  const profile = await temporaryFolder(t, 'cevra-usage-');
  let clock = time;
  const budget = createUsageBudget(profile, () => clock);
  await budget.setLimit(2);
  const { quote } = await budget.quote(...request);
  const first = randomUUID();
  const second = randomUUID();
  const results = await Promise.allSettled([budget.reserve(first, model, quote), budget.reserve(second, model, quote)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'BUDGET_EXCEEDED');
  const settled = await budget.finish(first, 'complete', { input: 20, output: 6 });
  assert.deepEqual(settled, { actual: 122, estimate: quote.micros });
  assert.equal(await budget.finish(first, 'complete', { input: 20, output: 6 }), null);
  await budget.reserve(second, model, quote);
  await budget.finish(second, 'cancelled');
  const restarted = createUsageBudget(profile, () => clock);
  assert.equal((await restarted.status()).used, settled.actual + quote.micros);
  await assert.rejects(restarted.quote(...request), { code: 'BUDGET_EXCEEDED' });
  clock += 86_400_000;
  assert.deepEqual(await restarted.status(), { day: '2026-11-15', used: 0, limitCents: 2, unpriced: 0 });
  await restarted.reserve(randomUUID(), model, (await restarted.quote(...request)).quote);
});

test('unpriced usage, excess reported usage and the bounded audit cannot bypass a limit', async t => {
  const profile = await temporaryFolder(t, 'cevra-usage-limits-');
  let clock = time;
  const budget = createUsageBudget(profile, () => clock);
  await budget.reserve(randomUUID(), model, null);
  await budget.setLimit(5);
  await assert.rejects(budget.quote(...request), { code: 'PRICE_UNAVAILABLE' });
  clock += 86_400_000;
  const { quote } = await budget.quote(...request);
  const id = randomUUID();
  await budget.reserve(id, model, quote);
  await budget.finish(id, 'complete', { input: 15_000, output: 1024 });
  await assert.rejects(budget.quote(...request), { code: 'BUDGET_EXCEEDED' });
  await budget.setLimit(null);
  for (let count = 0; count < 45; count++) await budget.reserve(randomUUID(), model, quote);
  const saved = JSON.parse(await fs.readFile(path.join(profile, 'intelligence', 'usage.json'), 'utf8'));
  assert.equal(saved.recent.length, 40);
  assert.equal(saved.used, 49_788 + 45 * quote.micros);
  assert.ok(saved.recent.every(item => item.outcome === 'pending' && item.usage === null));
  const next = randomUUID();
  await budget.reserve(next, model, quote);
  await budget.finish(next, 'unsent');
  assert.equal((await budget.status()).used, saved.used);
});

test('ledger fails closed on malformed data and an atomic write can retry without charging twice', async t => {
  const profile = await temporaryFolder(t, 'cevra-usage-write-');
  const budget = createUsageBudget(profile, () => time);
  const { quote } = await budget.quote(...request);
  const file = path.join(profile, 'intelligence', 'usage.json');
  await fs.mkdir(file, { recursive: true });
  const id = randomUUID();
  await assert.rejects(budget.reserve(id, model, quote), { code: 'BUDGET_UNAVAILABLE' });
  await fs.rmdir(file);
  await budget.reserve(id, model, quote);
  assert.equal((await budget.status()).used, quote.micros);
  await fs.writeFile(file, '{"version":1}');
  await assert.rejects(createUsageBudget(profile, () => time).quote(...request), { code: 'BUDGET_UNAVAILABLE' });
});
