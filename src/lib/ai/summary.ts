// The "table of contents" index. For each spine section we keep one short
// summary (+ its embedding) so whole-book / theme questions — which no single
// leaf chunk can answer — are answered from the section gists instead.
//
// Summaries are built from the leaf chunks already in the DB (grouped by
// section), so this needs no epub re-render and can run lazily on an
// already-indexed book. It is resumable: sections that already have a summary
// are skipped.
import { getBookChunks, getBookSummaries, saveSummaries } from '../db'
import { dot, norm } from './vectorMath'
import type { AIProvider } from './types'
import type { Chunk, SectionSummary } from './types'

const SECTION_CONCURRENCY = 4
const MIN_SECTION_CHARS = 160 // skip front-matter / tiny sections
const MAX_SECTION_CHARS = 2400 // cap text fed to the model (cost / context)

export interface SummaryProgress {
  done: number
  total: number
}

interface SectionDoc {
  sectionIndex: number
  cfi: string
  title: string
  text: string
}

// Group a book's book-text chunks back into per-section documents, in order.
function groupSections(chunks: Chunk[]): SectionDoc[] {
  const bySection = new Map<number, Chunk[]>()
  for (const c of chunks) {
    if (c.source !== 'book') continue
    const arr = bySection.get(c.sectionIndex) ?? []
    arr.push(c)
    bySection.set(c.sectionIndex, arr)
  }
  const docs: SectionDoc[] = []
  for (const [sectionIndex, arr] of bySection) {
    arr.sort((a, b) => a.seq - b.seq)
    const full = arr.map((c) => c.text).join('\n')
    if (full.length < MIN_SECTION_CHARS) continue
    // a short, human-ish title from the first line of the section
    const firstLine = (arr[0].text.split('\n')[0] ?? '').trim()
    const title = firstLine.length <= 40 ? firstLine : firstLine.slice(0, 40)
    docs.push({
      sectionIndex,
      cfi: arr[0].cfi,
      title,
      text: full.slice(0, MAX_SECTION_CHARS),
    })
  }
  docs.sort((a, b) => a.sectionIndex - b.sectionIndex)
  return docs
}

async function summarizeOne(provider: AIProvider, doc: SectionDoc, signal?: AbortSignal): Promise<string> {
  const system =
    '你是图书内容索引助手。用一两句中文准确概括这一节的核心内容（讲了什么、提出了什么观点或案例），' +
    '不要寒暄、不要加引号、不要照抄原句，只给概括本身。'
  const text = await provider.chat({
    system,
    messages: [{ role: 'user', content: `这一节的正文如下：\n\n${doc.text}\n\n请用一两句话概括这一节。` }],
    maxTokens: 160,
    signal,
  })
  return text.trim().replace(/^["「『]|["」』]$/g, '')
}

// Build summaries for any sections that don't have one yet. Returns the full,
// ordered set for the book (existing + newly built).
export async function buildSummaries(
  bookId: string,
  provider: AIProvider,
  opts: { signal?: AbortSignal; onProgress?: (p: SummaryProgress) => void } = {},
): Promise<SectionSummary[]> {
  const { signal, onProgress } = opts
  const [chunks, existing] = await Promise.all([getBookChunks(bookId), getBookSummaries(bookId)])
  const have = new Set(existing.map((s) => s.sectionIndex))
  const docs = groupSections(chunks)
  const todo = docs.filter((d) => !have.has(d.sectionIndex))
  if (!todo.length) return existing

  const total = docs.length
  let done = total - todo.length
  onProgress?.({ done, total })

  // 1. summarize (chat) with bounded concurrency
  const summaries = new Array<string>(todo.length)
  let cursor = 0
  let failed: Error | null = null
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= todo.length || failed || signal?.aborted) return
      try {
        summaries[i] = await summarizeOne(provider, todo[i], signal)
      } catch (e) {
        failed = e as Error
        return
      }
      done++
      onProgress?.({ done, total })
    }
  }
  await Promise.all(Array.from({ length: SECTION_CONCURRENCY }, worker))
  if (failed) throw failed
  if (signal?.aborted) return existing

  // 2. embed all new summaries (one batch — they're short)
  const vecs = await provider.embed(todo.map((d, i) => summaries[i] || d.title || d.text.slice(0, 200)))

  const built: SectionSummary[] = todo.map((d, i) => ({
    id: `${bookId}:s${d.sectionIndex}`,
    bookId,
    sectionIndex: d.sectionIndex,
    title: d.title,
    summary: summaries[i] || '',
    cfi: d.cfi,
    vec: vecs[i],
  }))
  await saveSummaries(built)
  return [...existing, ...built].sort((a, b) => a.sectionIndex - b.sectionIndex)
}

// For a global question: keep every section summary when there are few, else
// pick the ones most related to the question (by cosine) so the whole-book
// answer stays grounded and within budget. Always returned in reading order.
const MAX_GLOBAL_SECTIONS = 36

export function pickSummaries(
  summaries: SectionSummary[],
  queryVec: Float32Array,
  maxN = MAX_GLOBAL_SECTIONS,
): SectionSummary[] {
  if (summaries.length <= maxN) return summaries
  const qn = norm(queryVec) || 1
  const scored = summaries.map((s) => ({
    s,
    score: dot(queryVec, s.vec) / (qn * (norm(s.vec) || 1)),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored
    .slice(0, maxN)
    .map((x) => x.s)
    .sort((a, b) => a.sectionIndex - b.sectionIndex)
}
