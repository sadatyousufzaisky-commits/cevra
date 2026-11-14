const fs = require('node:fs/promises');
const path = require('node:path');
const { writeAtomic } = require('../atomic-file.cjs');
const { readCheckedFile } = require('../extensions/inspect-package.cjs');
const { exactRecord, ProviderError } = require('./provider-contract.cjs');

const rateCard = Object.freeze({
  modelId: 'gpt-5.6-terra', checked: '2026-11-14', expires: '2027-02-12',
  cacheWriteInput: 2.5, output: 12,
});
const maxLimitCents = 100_000;
const recentLimit = 40;
const outcomes = new Set(['pending', 'complete', 'error', 'cancelled', 'unsent']);
const integer = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const dayOf = time => new Date(time).toISOString().slice(0, 10);
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function estimateOpenAI(modelId, inputBytes, messageCount, outputCap, day) {
  if (modelId !== rateCard.modelId || day < rateCard.checked || day >= rateCard.expires) return null;
  // Allow one token per UTF-8 byte and add framing headroom. The API can tokenize differently.
  const inputAllowance = inputBytes + 64 * messageCount + 256;
  return { inputAllowance, micros: Math.ceil(inputAllowance * rateCard.cacheWriteInput) + outputCap * rateCard.output,
    checked: rateCard.checked };
}

function estimateUsage({ input, output }) {
  const longContext = input > 272_000;
  return Math.ceil(input * rateCard.cacheWriteInput * (longContext ? 2 : 1)) + output * rateCard.output * (longContext ? 1.5 : 1);
}

function validEntry(row) {
  return exactRecord(row, ['id', 'modelId', 'started', 'finished', 'estimate', 'rateDate', 'outcome', 'usage', 'actual']) &&
    typeof row.id === 'string' && requestId.test(row.id) && row.modelId === rateCard.modelId && integer(row.started, 8.64e15) &&
    (row.finished === null || integer(row.finished)) && (row.estimate === null || integer(row.estimate)) &&
    (row.rateDate === null || typeof row.rateDate === 'string' && dayPattern.test(row.rateDate)) && outcomes.has(row.outcome) &&
    (row.usage === null || exactRecord(row.usage, ['input', 'output']) && integer(row.usage.input, 1_000_000_000) &&
      integer(row.usage.output, 8192)) && (row.actual === null || integer(row.actual));
}

function createUsageBudget(profile, now = () => Date.now()) {
  const folder = path.join(profile, 'intelligence');
  const file = path.join(folder, 'usage.json');
  let pending = Promise.resolve();
  let state;

  async function checkFolder() {
    const expected = path.join(await fs.realpath(profile), 'intelligence');
    const stat = await fs.lstat(folder, { bigint: true });
    if (!stat.isDirectory() || path.relative(expected, await fs.realpath(folder))) throw new Error();
    return stat;
  }

  async function load() {
    if (state) return state;
    try {
      await checkFolder();
      const bytes = await readCheckedFile(file, 32 * 1024);
      const data = JSON.parse(bytes.toString('utf8'));
      if (!exactRecord(data, ['version', 'day', 'limitCents', 'used', 'unpriced', 'recent']) || data.version !== 1 ||
          typeof data.day !== 'string' || !dayPattern.test(data.day) ||
          !(data.limitCents === null || integer(data.limitCents, maxLimitCents)) || !integer(data.used) ||
          !integer(data.unpriced) || !Array.isArray(data.recent) || data.recent.length > recentLimit ||
          !data.recent.every(validEntry) || new Set(data.recent.map(row => row.id)).size !== data.recent.length ||
          !Buffer.from(JSON.stringify(data) + '\n').equals(bytes)) throw new Error();
      return state = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new ProviderError('BUDGET_UNAVAILABLE');
      return state = { version: 1, day: dayOf(now()), limitCents: null, used: 0, unpriced: 0, recent: [] };
    }
  }

  function serial(operation) {
    const result = pending.then(async () => {
      const saved = await load();
      const day = dayOf(now());
      return operation(day > saved.day ? { ...saved, day, used: 0, unpriced: 0 } : saved);
    });
    pending = result.catch(() => {});
    return result;
  }

  async function save(next) {
    try {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const stat = await checkFolder();
      await writeAtomic(file, JSON.stringify(next) + '\n', { beforeCommit: async () => {
        const current = await checkFolder();
        if (current.dev !== stat.dev || current.ino !== stat.ino || current.birthtimeNs !== stat.birthtimeNs) throw new Error();
      } });
      state = next;
    } catch { throw new ProviderError('BUDGET_UNAVAILABLE'); }
  }

  function summary({ day, used, limitCents, unpriced }) { return { day, used, limitCents, unpriced }; }

  function check(data, quote) {
    if (data.limitCents === null) return;
    if (!quote || data.unpriced) throw new ProviderError('PRICE_UNAVAILABLE');
    if (data.used + quote.micros > data.limitCents * 10_000) throw new ProviderError('BUDGET_EXCEEDED');
  }

  return {
    status: () => serial(summary),
    setLimit: limitCents => serial(async data => {
      if (limitCents !== null && !integer(limitCents, maxLimitCents)) throw new ProviderError('INVALID_REQUEST');
      const next = { ...data, limitCents };
      await save(next);
      return summary(next);
    }),
    quote: (modelId, inputBytes, messageCount, outputCap) => serial(data => {
      const quote = estimateOpenAI(modelId, inputBytes, messageCount, outputCap, dayOf(now()));
      check(data, quote);
      return { quote, ...summary(data) };
    }),
    reserve: (id, modelId, quote) => serial(async data => {
      if (quote && dayOf(now()) >= rateCard.expires) throw new ProviderError('PRICE_UNAVAILABLE');
      if (data.day !== dayOf(now())) throw new ProviderError('BUDGET_UNAVAILABLE');
      check(data, quote);
      if (data.recent.some(row => row.id === id)) throw new ProviderError('INVALID_REQUEST');
      const entry = { id, modelId, started: now(), finished: null, estimate: quote?.micros ?? null,
        rateDate: quote?.checked ?? null, outcome: 'pending', usage: null, actual: null };
      if (!validEntry(entry)) throw new ProviderError('INVALID_REQUEST');
      await save({ ...data, used: data.used + (quote?.micros ?? 0), unpriced: data.unpriced + Number(!quote),
        recent: [...data.recent.slice(1 - recentLimit), entry] });
    }),
    finish: (id, outcome, usage) => serial(async data => {
      const entry = data.recent.find(row => row.id === id);
      if (entry?.outcome !== 'pending' || outcome === 'pending' || !outcomes.has(outcome)) return null;
      const actual = usage && entry.estimate !== null ? estimateUsage(usage) : null;
      const settled = { ...entry, outcome, finished: now(), usage: usage ?? null, actual };
      if (!validEntry(settled)) throw new ProviderError('PROVIDER_PROTOCOL');
      const currentDay = dayOf(entry.started) >= data.day;
      const difference = outcome === 'unsent' ? -(entry.estimate ?? 0) : actual === null ? 0 : actual - entry.estimate;
      await save({ ...data, used: data.used + (currentDay ? difference : 0),
        unpriced: data.unpriced - Number(currentDay && outcome === 'unsent' && entry.estimate === null),
        recent: data.recent.map(row => row === entry ? settled : row) });
      return { actual, estimate: entry.estimate };
    }),
  };
}

module.exports = { createUsageBudget, estimateOpenAI };
