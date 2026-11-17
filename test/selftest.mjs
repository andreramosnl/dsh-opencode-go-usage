// Pure-function checks for the OpenCode Go usage meter. Run with the DSH
// Electron binary as Node: `node-asar.ps1 selftest.mjs`.
import assert from 'node:assert/strict'
import { foldSessionCost, normalizeUsageReply } from '../index.js'

const prices = {
  'deepseek-v4.1-flash': {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.003,
    cacheWrite: 0,
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  },
}
const config = { prices, monthlyLimits: { 'deepseek-v4.1-flash': 100 } }

// Wednesday 02:00 UTC is a DeepSeek peak hour; Saturday 02:00 UTC is not.
const wednesdayPeak = Date.UTC(2026, 10, 18, 2, 0)
const saturdayOffPeak = Date.UTC(2026, 10, 21, 2, 0)

const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }

function messageEvent(time, extra = {}) {
  return {
    type: 'assistant/message',
    seq: 1,
    time,
    data: {
      turn: 0,
      step: 0,
      usage,
      stream: [],
      message: { role: 'assistant', source: { kind: 'model', provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
      ...extra,
    },
  }
}

const offPeak = foldSessionCost([messageEvent(saturdayOffPeak)], config)
assert.equal(offPeak.calls, 1)
assert.equal(offPeak.tokens.input, 1_000_000)
assert.ok(Math.abs(offPeak.costUsd - (0.15 + 0.6 + 0.003)) < 1e-9, `off-peak cost ${offPeak.costUsd}`)

const peak = foldSessionCost([messageEvent(wednesdayPeak)], config)
assert.ok(Math.abs(peak.costUsd - (0.3 + 1.2 + 0.006)) < 1e-9, `peak cost ${peak.costUsd}`)

// A retried attempt is a second billed request; the attempt borrows the route
// from the request header that preceded it.
const retried = foldSessionCost([
  { type: 'request/header', seq: 0, time: saturdayOffPeak, data: { header: { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }, reason: 'initial' } },
  { type: 'assistant/attempt', seq: 1, time: saturdayOffPeak, data: { turn: 0, step: 0, stream: [{ type: 'chunk', time: saturdayOffPeak, chunk: { type: 'usage', usage } }] } },
  messageEvent(saturdayOffPeak),
], config)
assert.equal(retried.calls, 2)
assert.ok(Math.abs(retried.costUsd - 2 * (0.15 + 0.6 + 0.003)) < 1e-9)

// An unpriced model keeps tokens but reports no cost for that row.
const unpriced = foldSessionCost([{
  type: 'assistant/message',
  seq: 1,
  time: saturdayOffPeak,
  data: { usage, stream: [], message: { source: { kind: 'model', provider: 'opencode-go', model: 'mystery-model' } } },
}], config)
assert.deepEqual(unpriced.unpricedModels, ['mystery-model'])
assert.equal(unpriced.costUsd, 0)
assert.equal(unpriced.tokens.output, 1_000_000)

// Both published usage reply shapes normalize to the same windows.
const merged = normalizeUsageReply({
  usage: {
    rolling: { status: 'ok', percent: 52, resetsAt: '2026-09-23T00:34:52.704Z' },
    weekly: { status: 'ok', percent: 20, resetsAt: '2026-09-28T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 61, resetsAt: '2026-09-25T14:30:41.000Z' },
  },
})
assert.equal(merged.windows.rolling.percent, 52)
assert.equal(merged.windows.weekly.percent, 20)
assert.equal(merged.windows.monthly.percent, 61)

const listed = normalizeUsageReply({
  plan: 'go',
  windows: [
    { name: 'rolling', status: 'ok', usagePercent: 10, resetsAt: '2026-09-23T00:34:52.704Z' },
    { name: 'weekly', usagePercent: 20 },
    { name: 'monthly', usagePercent: 30, used: 3, limit: 10 },
  ],
})
assert.equal(listed.plan, 'go')
assert.equal(listed.windows.rolling.percent, 10)
assert.equal(listed.windows.monthly.percent, 30)
assert.equal(listed.windows.monthly.used, 3)

// A derived percentage from used/limit, and a legacy single-window map.
const derived = normalizeUsageReply({ usage: { monthly: { used: 5, limit: 20 } } })
assert.equal(derived.windows.monthly.percent, 25)

console.log('opencode-go-usage selftest: ok')
