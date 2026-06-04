// LLM listwise reranker. The third-party relay only exposes embeddings + chat
// (no dedicated rerank endpoint), so precision comes from one cheap chat call:
// show the question and the numbered candidate passages, ask which are actually
// relevant, in order. This is the single biggest precision lever in this RAG —
// it strips the off-topic passages that otherwise drag the answer off course.
//
// Robust by construction: anything we can't parse falls back to the input order,
// so a flaky relay degrades to "no rerank" rather than to an error.
import type { AIProvider } from './types'
import type { RetrievedChunk } from './retrieve'

const SNIPPET_CHARS = 200

// Extract a list of 1-based indices from a model reply, tolerating prose,
// code fences, or a bare comma/space-separated list.
function parseOrder(reply: string, n: number): number[] {
  let nums: number[] = []
  const arr = reply.match(/\[[\s\S]*?\]/)
  if (arr) {
    try {
      const parsed = JSON.parse(arr[0])
      if (Array.isArray(parsed)) nums = parsed.map((x) => Number(x)).filter((x) => Number.isFinite(x))
    } catch {
      /* fall through to loose scan */
    }
  }
  if (!nums.length) nums = (reply.match(/\d+/g) ?? []).map(Number)
  const seen = new Set<number>()
  const out: number[] = []
  for (const x of nums) {
    const i = x - 1
    if (i >= 0 && i < n && !seen.has(i)) {
      seen.add(i)
      out.push(i)
    }
  }
  return out
}

export async function rerankHits(
  provider: AIProvider,
  query: string,
  hits: RetrievedChunk[],
  topN: number,
  signal?: AbortSignal,
): Promise<RetrievedChunk[]> {
  if (hits.length <= topN) return hits

  const list = hits
    .map((h, i) => `[${i + 1}] ${h.chunk.text.replace(/\s+/g, ' ').slice(0, SNIPPET_CHARS)}`)
    .join('\n')
  const system =
    '你是检索重排助手。下面是用户的问题和若干编号的候选段落。' +
    `请挑出与问题最相关、能直接帮助回答的段落，按相关性从高到低，最多 ${topN} 个，` +
    '只输出一个 JSON 数组的编号，例如 [3,1,7]。与问题无关的不要选；都不相关就输出 []。'

  let reply: string
  try {
    reply = await provider.chat({
      system,
      messages: [{ role: 'user', content: `问题：${query}\n\n候选段落：\n${list}` }],
      maxTokens: 80,
      signal,
    })
  } catch {
    return hits.slice(0, topN) // relay hiccup → keep hybrid order
  }

  const order = parseOrder(reply, hits.length)
  if (!order.length) return hits.slice(0, topN)
  const picked = order.slice(0, topN).map((i) => hits[i])
  // if the model returned very few, top up from the original order so the model
  // still gets enough context to work with
  if (picked.length < topN) {
    const used = new Set(order)
    for (let i = 0; i < hits.length && picked.length < topN; i++) {
      if (!used.has(i)) picked.push(hits[i])
    }
  }
  return picked
}
