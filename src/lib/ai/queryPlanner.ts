// Query understanding, run before retrieval. Two jobs:
//
// 1. Condense — rewrite a follow-up ("那它的反面呢？", "展开讲讲") into a
//    self-contained question using the recent conversation. Without this, the
//    retrieval embedding for a follow-up is meaningless and the search lands on
//    unrelated passages — the main cause of "答非所问" in a multi-turn chat.
//    (The chat model already saw the history; the *retriever* did not.)
//
// 2. Classify scope — 'global' (whole-book / theme / summary, answered from
//    section summaries) vs 'local' (a specific passage or fact, answered from
//    leaf-chunk retrieval).
//
// First turn with no history skips the LLM call entirely (heuristic scope), so
// the common case keeps today's latency. Any failure falls back to local +
// the raw question.
import type { AIProvider, ChatMessage, QueryPlan, QueryScope } from './types'

// Whole-book / overview cues. Deliberately broad — a false 'global' just feeds
// section summaries, which is a reasonable answer base anyway.
const GLOBAL_RE =
  /(全书|整本|这本书|本书|通篇|全文|大意|主旨|主题|核心(观点|思想|论点)|中心思想|讲(了)?什么|讲的是什么|说了什么|概括|概览|梗概|总结|归纳|框架|脉络|作者(想|要)?(表达|说明|论证))/

export function heuristicScope(q: string): QueryScope {
  return GLOBAL_RE.test(q) ? 'global' : 'local'
}

function parseScope(s: unknown): QueryScope {
  return s === 'global' ? 'global' : 'local'
}

export async function planQuery(
  provider: AIProvider,
  args: {
    question: string
    quote?: string
    history: ChatMessage[] // prior turns (user+assistant), oldest→newest
    signal?: AbortSignal
  },
): Promise<QueryPlan> {
  const { question, quote, history, signal } = args
  const raw = [quote, question].filter(Boolean).join('\n')

  // first turn (or no real history) → no condense needed
  if (history.length === 0) {
    return { standalone: raw, scope: heuristicScope(question || quote || '') }
  }

  const convo = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 300)}`)
    .join('\n')
  const system =
    '你在帮一个「与书对话」的检索系统改写问题。根据对话历史，把用户最新的提问改写成一个不依赖上下文、' +
    '可独立检索的完整问题（补全省略的指代和主语，保留原意，不要回答它）。同时判断它属于：' +
    'global=关于全书/主题/总体观点的概览类问题，local=关于某个具体段落/事实/术语的问题。' +
    '只输出 JSON：{"standalone":"...","scope":"global|local"}'

  try {
    const reply = await provider.chat({
      system,
      messages: [
        { role: 'user', content: `对话历史：\n${convo}\n\n用户最新提问：${question || quote || ''}` },
      ],
      maxTokens: 200,
      signal,
    })
    const m = reply.match(/\{[\s\S]*\}/)
    if (m) {
      const obj = JSON.parse(m[0]) as { standalone?: unknown; scope?: unknown }
      const standalone = typeof obj.standalone === 'string' && obj.standalone.trim() ? obj.standalone.trim() : raw
      return { standalone: quote ? `${quote}\n${standalone}` : standalone, scope: parseScope(obj.scope) }
    }
  } catch {
    /* fall through */
  }
  return { standalone: raw, scope: heuristicScope(question || quote || '') }
}
