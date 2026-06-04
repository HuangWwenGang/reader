// Build a book's RAG index: render each spine section off-screen, slice it into
// retrievable chunks anchored to real CFIs (so an answer can jump back to the
// exact spot), add the user's highlights/notes as high-priority chunks, embed
// everything in batches via the configured provider, and store it.
import {
  getBook,
  getHighlights,
  getBookVectors,
  saveChunksWithVectors,
  saveBookIndexMeta,
} from '../db'
import { openBookFromBuffer } from '../epub'
import { loadAIConfig } from './config'
import { makeProvider } from './providers'
import type { Chunk } from './types'

const TARGET_CHARS = 320
const BLOCK_SEL = 'p, li, blockquote, dd, h1, h2, h3, h4, h5, h6'
const EMBED_BATCH = 48 // fewer round-trips for a latency-bound relay
const EMBED_CONCURRENCY = 4 // run several batches at once to beat slow relays

export interface IndexProgress {
  phase: 'render' | 'embed' | 'done' | 'error'
  sectionsDone: number
  sectionsTotal: number
  chunks: number
  chunksTotal?: number // total chunks to embed (for embed-phase progress)
  error?: string
}

export async function indexBook(
  bookId: string,
  onProgress?: (p: IndexProgress) => void,
): Promise<void> {
  const config = loadAIConfig()
  const provider = makeProvider(config)
  const rec = await getBook(bookId)
  const buf = rec?.file
  if (!buf) throw new Error('找不到这本书或数据无效')

  const book = openBookFromBuffer(buf)
  await book.ready
  const sections: any[] = []
  book.spine.each((s: any) => {
    if (s && s.linear !== false) sections.push(s)
  })
  const total = sections.length

  const iframe = document.createElement('iframe')
  Object.assign(iframe.style, {
    position: 'absolute', left: '-99999px', top: '0',
    width: '800px', height: '10px', border: '0', visibility: 'hidden',
  } as any)
  document.body.appendChild(iframe)

  const chunks: Chunk[] = []
  let seq = 0
  try {
    // NOTE: do NOT clear the existing index — re-running resumes (skips chunks
    // that already have a vector), so a slow/flaky relay can finish across tries.
    await saveBookIndexMeta({
      bookId, state: 'indexing', model: provider.embedModel, dim: provider.embedDim,
      chunkCount: 0, sectionsDone: 0, sectionsTotal: total, updatedAt: Date.now(),
    })

    // 1. book text → CFI-anchored chunks
    for (let i = 0; i < sections.length; i++) {
      const doc = await renderToIframe(iframe, await sections[i].render(book.load.bind(book)))
      if (doc) {
        for (const c of blockChunks(doc, sections[i], i, bookId, () => seq++)) chunks.push(c)
      }
      onProgress?.({ phase: 'render', sectionsDone: i + 1, sectionsTotal: total, chunks: chunks.length })
    }

    // 2. highlights + notes as high-priority chunks
    for (const h of await getHighlights(bookId)) {
      const note = (h.note ?? '').trim()
      const text = note
        ? `${h.text}\n（我的想法：${note}${h.tag ? '；标签：' + h.tag : ''}）`
        : h.text
      chunks.push({
        id: `${bookId}:h${h.id}`, bookId, seq: seq++, sectionIndex: -1,
        cfi: h.cfi, text, source: 'note', tag: h.tag,
      })
    }

    // 3. embed only the chunks that don't already have a vector (resume), saving
    //    each batch as it lands, with several batches in flight at once.
    const haveVec = new Set((await getBookVectors(bookId)).map((v) => v.id))
    const todo = chunks.filter((c) => !haveVec.has(c.id))
    let done = chunks.length - todo.length
    onProgress?.({
      phase: 'embed', sectionsDone: total, sectionsTotal: total,
      chunks: done, chunksTotal: chunks.length,
    })

    let cursor = 0
    let failed: Error | null = null
    const worker = async () => {
      for (;;) {
        const start = cursor
        cursor += EMBED_BATCH
        if (start >= todo.length || failed) return
        const batch = todo.slice(start, start + EMBED_BATCH)
        const texts = batch.map((c) => c.text)
        let vecs: Float32Array[]
        try {
          vecs = await provider.embed(texts)
        } catch {
          await new Promise((r) => setTimeout(r, 800))
          try {
            vecs = await provider.embed(texts)
          } catch (e) {
            failed = e as Error
            return
          }
        }
        await saveChunksWithVectors(bookId, batch.map((c, j) => ({ chunk: c, vec: vecs[j] })))
        done += batch.length
        onProgress?.({
          phase: 'embed', sectionsDone: total, sectionsTotal: total,
          chunks: done, chunksTotal: chunks.length,
        })
      }
    }
    await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, worker))
    if (failed) throw failed
    await saveBookIndexMeta({
      bookId, state: 'ready', model: provider.embedModel, dim: provider.embedDim,
      chunkCount: chunks.length, sectionsDone: total, sectionsTotal: total, updatedAt: Date.now(),
    })
    onProgress?.({ phase: 'done', sectionsDone: total, sectionsTotal: total, chunks: chunks.length })
  } catch (e) {
    const msg = (e as Error).message
    await saveBookIndexMeta({
      bookId, state: 'error', model: provider.embedModel, dim: provider.embedDim,
      chunkCount: chunks.length, sectionsDone: 0, sectionsTotal: total, error: msg, updatedAt: Date.now(),
    }).catch(() => {})
    onProgress?.({ phase: 'error', sectionsDone: 0, sectionsTotal: total, chunks: chunks.length, error: msg })
    throw e
  } finally {
    iframe.remove()
    try {
      book.destroy()
    } catch {
      /* ignore */
    }
  }
}

function renderToIframe(iframe: HTMLIFrameElement, html: string): Promise<Document | null> {
  return new Promise((resolve) => {
    const onload = () => {
      iframe.removeEventListener('load', onload)
      resolve(iframe.contentDocument)
    }
    iframe.addEventListener('load', onload)
    iframe.srcdoc = html
  })
}

// Pack leaf block elements into ~TARGET_CHARS chunks; each chunk's CFI is its
// first block's CFI so an answer can jump back there.
function blockChunks(
  doc: Document,
  section: any,
  sectionIndex: number,
  bookId: string,
  nextSeq: () => number,
): Chunk[] {
  const blocks = Array.from(doc.querySelectorAll(BLOCK_SEL)).filter(
    (el) => (el.textContent ?? '').trim().length > 0 && !el.querySelector(BLOCK_SEL),
  )
  const out: Chunk[] = []
  let cur: { text: string; cfi: string }[] = []
  let len = 0
  const flush = () => {
    if (!cur.length) return
    const s = nextSeq()
    out.push({
      id: `${bookId}:b${s}`, bookId, seq: s, sectionIndex,
      cfi: cur[0].cfi, text: cur.map((c) => c.text).join('\n'), source: 'book',
    })
    cur = []
    len = 0
  }
  for (const el of blocks) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    let cfi = ''
    try {
      // a range over the block resolves back far more reliably than an
      // element CFI (this is the same path highlights use), so citation jumps
      // land on the right paragraph
      const range = doc.createRange()
      range.selectNodeContents(el)
      cfi = section.cfiFromRange(range)
    } catch {
      try {
        cfi = section.cfiFromElement(el)
      } catch {
        /* best effort */
      }
    }
    if (len > 0 && len + text.length > TARGET_CHARS) flush()
    cur.push({ text, cfi })
    len += text.length + 1
  }
  flush()
  return out
}
