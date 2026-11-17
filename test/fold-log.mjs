// Fold a real durable Session log through the meter's pure folder, to check the
// numbers the Host would report. Usage: node fold-log.mjs <session.v4.jsonl>
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync, createZstdDecompress } from 'node:zlib'
import { foldSessionCost } from '../index.js'

const prices = {
  'deepseek-v4.1-flash': {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.003,
    cacheWrite: 0,
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  },
  'deepseek-v4-pro': {
    input: 0.66,
    output: 1.98,
    cacheRead: 0.022,
    cacheWrite: 0,
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
  },
}
const config = { prices, monthlyLimits: { 'deepseek-v4.1-flash': 100, 'deepseek-v4-pro': 15 } }

function newestLog(root) {
  const found = []
  for (const cwd of readdirSync(root)) {
    const dir = join(root, cwd)
    if (!statSync(dir).isDirectory()) continue
    for (const session of readdirSync(dir)) {
      for (const name of ['session.v4.jsonl', 'session.v4.jsonl.zstd']) {
        const file = join(dir, session, name)
        try {
          found.push({ file, at: statSync(file).mtimeMs })
        } catch {}
      }
    }
  }
  found.sort((a, b) => b.at - a.at)
  return found[0]?.file
}

const root = process.argv[3] ?? join(process.env.USERPROFILE, '.dsh', 'sessions')
const file = process.argv[2] ?? newestLog(root)
if (!file) {
  console.error('no session log found')
  process.exit(1)
}

const raw = readFileSync(file)
let text
if (file.endsWith('.zstd')) {
  // The durable log appends one zstd frame per flush; neither the one-shot nor
  // the streaming decoder continues past the first frame, so split on the frame
  // magic (0x28B52FFD) and decode each frame on its own.
  text = decodeFrames(raw)
} else {
  text = raw.toString('utf8')
}

function decodeFrames(buffer) {
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === magic[0] && buffer[index + 1] === magic[1]
      && buffer[index + 2] === magic[2] && buffer[index + 3] === magic[3]) starts.push(index)
  }
  const parts = []
  for (let frame = 0; frame < starts.length; frame += 1) {
    const end = frame + 1 < starts.length ? starts[frame + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(starts[frame], end)).toString('utf8'))
    } catch {
      // A magic sequence inside compressed bytes is not a frame boundary.
    }
  }
  return parts.join('')
}
const events = text
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line))

const fold = foldSessionCost(events, config)
console.log(JSON.stringify({
  file,
  events: events.length,
  costUsd: Number(fold.costUsd.toFixed(4)),
  calls: fold.calls,
  tokens: fold.tokens,
  models: fold.models.map((row) => ({ key: `${row.provider}/${row.model}`, costUsd: Number(row.costUsd.toFixed(4)), calls: row.calls })),
  unpricedModels: fold.unpricedModels,
}, null, 2))
