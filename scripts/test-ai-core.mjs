// Unit test for the pure RAG utilities (chunking + vector math). Uses esbuild
// (a vite dependency) to transpile the TS modules in-memory — no test runner.
import esbuild from 'esbuild'

async function load(entry) {
  const r = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
  })
  const b64 = Buffer.from(r.outputFiles[0].text).toString('base64')
  return import('data:text/javascript;base64,' + b64)
}

let failed = false
const check = (c, m) => {
  console.log(`• ${c ? 'PASS' : 'FAIL'} — ${m}`)
  if (!c) failed = true
}

const { chunkText } = await load('src/lib/ai/chunk.ts')
const { cosine, topK } = await load('src/lib/ai/vectorMath.ts')

// ---- chunkText ----
const para = (n) =>
  `这是第${n}段。家庭中的正义总是以亲密关系为出发点；委屈就是家庭政治中的不公和挫败。` +
  `The quick brown fox jumps over the lazy dog, again and again and again.`
const text = Array.from({ length: 12 }, (_, i) => para(i + 1)).join('\n\n')

const chunks = chunkText(text, 320, 48)
check(chunks.length >= 3, `splits into multiple chunks (got ${chunks.length})`)
check(
  chunks.every((c) => c.text.length <= 320 + 80),
  'no chunk wildly exceeds the target size',
)
check(
  chunks.every((c) => c.start >= 0 && c.end <= text.length && c.start < c.end),
  'offsets are in range and ordered',
)
check(
  chunks.every((c) => c.text.trim().length > 0),
  'no empty chunks',
)
// a very long single paragraph must be broken on sentence boundaries
const long = '句子。'.repeat(400) // 1200 chars, no paragraph breaks
const lc = chunkText(long, 320, 48)
check(lc.length >= 3, `long paragraph is sentence-split (got ${lc.length})`)
check(lc.every((c) => c.text.length <= 320 + 80), 'sentence-split chunks bounded')

// ---- cosine / topK ----
const v = (arr) => Float32Array.from(arr)
check(Math.abs(cosine(v([1, 0, 0]), v([1, 0, 0])) - 1) < 1e-6, 'cosine identical = 1')
check(Math.abs(cosine(v([1, 0, 0]), v([0, 1, 0]))) < 1e-6, 'cosine orthogonal = 0')
check(cosine(v([1, 1]), v([2, 2])) > 0.999, 'cosine parallel ≈ 1')

const items = [
  { id: 'b:b1', vec: v([1, 0, 0]) },
  { id: 'b:b2', vec: v([0.2, 1, 0]) },
  { id: 'b:h9', vec: v([0.9, 0.1, 0]) }, // a note, slightly off
]
const q = v([1, 0, 0])
const ranked = topK(q, items, 3)
check(ranked[0].id === 'b:b1', 'topK ranks the closest first')
check(ranked.length === 3 && ranked[0].score >= ranked[1].score, 'topK sorted desc')
// note boost can lift a note above a marginally-closer book chunk
const boosted = topK(q, items, 3, (id) => (id.split(':')[1]?.startsWith('h') ? 0.2 : 0))
check(boosted[0].id === 'b:h9', 'note boost lifts the note to the top')

console.log(failed ? '\nAI CORE: FAILED' : '\nAI CORE: PASSED')
process.exit(failed ? 1 : 0)
