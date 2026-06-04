// Given a query embedding, find the most relevant chunks for a book. The user's
// own notes get a small boost so their thinking surfaces alongside the source.
import { getBookVectors, getChunksByIds } from '../db'
import { topK } from './vectorMath'
import type { Chunk } from './types'

export interface RetrievedChunk {
  chunk: Chunk
  score: number
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
    if (parts.length) out.push({ text: parts.map((p) => p.text).join('\n'), cfi: c.cfi, source: 'book' })
  }
  return out
}

export async function retrieve(
  bookId: string,
  queryVec: Float32Array,
  k = 8,
  noteBoost = 0.04,
): Promise<RetrievedChunk[]> {
  const vecs = await getBookVectors(bookId)
  if (!vecs.length) return []
  const scored = topK(
    queryVec,
    vecs.map((v) => ({ id: v.id, vec: v.vec })),
    k,
    (id) => (id.split(':')[1]?.startsWith('h') ? noteBoost : 0),
  )
  const chunks = await getChunksByIds(scored.map((s) => s.id))
  const byId = new Map(chunks.map((c) => [c.id, c]))
  return scored
    .map((s) => ({ chunk: byId.get(s.id)!, score: s.score }))
    .filter((r) => r.chunk)
}
