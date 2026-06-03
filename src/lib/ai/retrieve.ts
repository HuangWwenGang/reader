// Given a query embedding, find the most relevant chunks for a book. The user's
// own notes get a small boost so their thinking surfaces alongside the source.
import { getBookVectors, getChunksByIds } from '../db'
import { topK } from './vectorMath'
import type { Chunk } from './types'

export interface RetrievedChunk {
  chunk: Chunk
  score: number
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
