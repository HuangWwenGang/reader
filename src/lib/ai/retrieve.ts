// Given a query embedding, find the most relevant chunks for a book. The user's
// own notes get a small boost so their thinking surfaces alongside the source.
import { getBookVectors, getChunksByIds, getBookChunks } from '../db'
import { dot, norm } from './vectorMath'
import type { Chunk } from './types'

export interface RetrievedChunk {
  chunk: Chunk
  score: number
}

// CJK 2–4-grams + latin words from the query, for keyword matching. (No Chinese
// tokenizer needed — n-grams catch terms like a section name "齐家".)
function queryTerms(q: string): string[] {
  const terms = new Set<string>()
  for (const run of q.match(/[一-鿿]+/g) ?? []) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) terms.add(run.slice(i, i + n))
    }
  }
  for (const w of q.match(/[a-zA-Z][a-zA-Z0-9]{1,}/g) ?? []) terms.add(w.toLowerCase())
  return [...terms]
}

// Hybrid retrieval: blend cosine similarity with a BM25-lite keyword score so
// exact terms (section names, proper nouns) are found even when the embeddings
// are mediocre. Robust against a low-quality embedding relay.
export async function retrieveHybrid(
  bookId: string,
  queryVec: Float32Array,
  queryText: string,
  k = 12,
): Promise<RetrievedChunk[]> {
  const [vecs, chunks] = await Promise.all([getBookVectors(bookId), getBookChunks(bookId)])
  if (!chunks.length) return []
  const byId = new Map(chunks.map((c) => [c.id, c]))

  // ---- vector cosine (normalised 0..1) ----
  const qn = norm(queryVec) || 1
  const vScore = new Map<string, number>()
  let vMax = 1e-6
  for (const v of vecs) {
    const s = dot(queryVec, v.vec) / (qn * (norm(v.vec) || 1))
    vScore.set(v.id, s)
    if (s > vMax) vMax = s
  }

  // ---- keyword (idf-weighted term overlap, normalised 0..1) ----
  const terms = queryTerms(queryText)
  const df = new Map<string, number>()
  for (const c of chunks) {
    const t = c.text
    for (const term of terms) if (t.includes(term)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const N = chunks.length
  const lScore = new Map<string, number>()
  let lMax = 1e-6
  for (const c of chunks) {
    let s = 0
    for (const term of terms) {
      if (c.text.includes(term)) {
        const idf = Math.log(1 + N / (1 + (df.get(term) ?? 0)))
        s += idf * Math.min(term.length, 6)
      }
    }
    if (s > 0) {
      lScore.set(c.id, s)
      if (s > lMax) lMax = s
    }
  }

  const hasLex = lMax > 1e-6
  const scored = chunks.map((c) => {
    const v = (vScore.get(c.id) ?? 0) / vMax
    const l = (lScore.get(c.id) ?? 0) / lMax
    const noteBoost = c.source === 'note' ? 0.05 : 0
    // when the query has strong keyword signal, lean on it (embeddings unreliable)
    const score = hasLex ? 0.5 * v + 0.5 * l + noteBoost : v + noteBoost
    return { id: c.id, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored
    .slice(0, k)
    .map((s) => ({ chunk: byId.get(s.id)!, score: s.score }))
    .filter((r) => r.chunk)
}

export interface ContextBlock {
  text: string // the hit plus its neighbours — a fuller passage, not a snippet
  cfi: string // the hit's CFI (for the citation jump)
  source: 'book' | 'note'
}

// Expand each hit with its adjacent chunks (same section) so the model sees full
// passages instead of isolated 320-char snippets. Notes are kept as-is.
export async function expandHits(
  bookId: string,
  hits: RetrievedChunk[],
  radius = 1,
): Promise<ContextBlock[]> {
  const seqOf = (id: string, fallback: number) => {
    const m = id.match(/:b(\d+)$/)
    return m ? parseInt(m[1], 10) : fallback
  }
  const want = new Set<string>()
  for (const h of hits) {
    if (h.chunk.source === 'note') continue
    const seq = seqOf(h.chunk.id, h.chunk.seq)
    for (let d = 1; d <= radius; d++) {
      want.add(`${bookId}:b${seq - d}`)
      want.add(`${bookId}:b${seq + d}`)
    }
  }
  const nbr = await getChunksByIds([...want])
  const byId = new Map(nbr.map((c) => [c.id, c]))
  const used = new Set<string>() // avoid repeating the same paragraph across blocks
  const out: ContextBlock[] = []
  for (const h of hits) {
    const c = h.chunk
    if (c.source === 'note') {
      out.push({ text: c.text, cfi: c.cfi, source: 'note' })
      continue
    }
    const seq = seqOf(c.id, c.seq)
    const parts: { seq: number; text: string }[] = []
    const add = (id: string, s: number, text: string) => {
      if (used.has(id)) return
      used.add(id)
      parts.push({ seq: s, text })
    }
    add(c.id, seq, c.text)
    for (let d = 1; d <= radius; d++) {
      for (const s of [seq - d, seq + d]) {
        const id = `${bookId}:b${s}`
        const nc = byId.get(id)
        if (nc && nc.sectionIndex === c.sectionIndex) add(id, s, nc.text)
      }
    }
    parts.sort((a, b) => a.seq - b.seq)
    // always include the hit's own paragraph even if a prior block borrowed it
    // as a neighbour, so every block (and its [编号]) maps to a real passage
    if (!parts.some((p) => p.seq === seq)) parts.unshift({ seq, text: c.text })
    out.push({ text: parts.map((p) => p.text).join('\n'), cfi: c.cfi, source: 'book' })
  }
  return out
}
