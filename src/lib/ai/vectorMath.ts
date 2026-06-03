// Vector similarity for brute-force retrieval. A personal library's per-book
// vector count (a few thousand) is tiny, so an exact cosine scan is plenty fast
// (<50ms) and needs no ANN index.

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a))
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const d = norm(a) * norm(b)
  return d === 0 ? 0 : dot(a, b) / d
}

export interface Scored {
  id: string
  score: number
}

// Top-k by cosine. `boost` lets callers up-weight certain ids (e.g. the user's
// own notes) by adding a small bonus to their score.
export function topK(
  query: Float32Array,
  items: { id: string; vec: Float32Array }[],
  k: number,
  boost?: (id: string) => number,
): Scored[] {
  const qn = norm(query) || 1
  const scored: Scored[] = items.map(({ id, vec }) => {
    const vn = norm(vec) || 1
    let score = dot(query, vec) / (qn * vn)
    if (boost) score += boost(id)
    return { id, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}
