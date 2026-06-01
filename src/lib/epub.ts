// Wrapper around epub.js. We use its `continuous` manager + `scrolled` flow to
// get true seamless infinite scrolling across chapters (foliate rendered one
// chapter at a time, which can't be seamless).
import ePub, { Book, EpubCFI } from 'epubjs'
import type { RenditionOptions } from 'epubjs/types/rendition'
import type { Settings } from './settings'
import { THEMES } from './settings'

export type { Book }

export function openBookFromBlob(blob: Blob): Promise<Book> {
  return blob.arrayBuffer().then((buf) => ePub(buf as ArrayBuffer))
}

export interface BookMeta {
  title: string
  author?: string
  cover?: Blob | null
}

// Parse an EPUB just enough for the shelf (title/author/cover).
export async function extractMeta(blob: Blob): Promise<BookMeta> {
  const book = ePub(await blob.arrayBuffer())
  try {
    await book.ready
    const meta = await book.loaded.metadata
    const title = meta?.title || '未命名书籍'
    const author = (meta?.creator as string) || undefined
    let cover: Blob | null = null
    try {
      const url = await book.coverUrl()
      if (url) cover = await (await fetch(url)).blob()
    } catch {
      cover = null
    }
    return { title, author, cover }
  } finally {
    book.destroy()
  }
}

// epub.js render options derived from settings. Scrolled → continuous manager
// (infinite scroll); paginated → default manager (column paging).
export function renderOptions(settings: Settings): RenditionOptions {
  const scrolled = settings.flow === 'scrolled'
  return {
    width: '100%',
    height: '100%',
    flow: scrolled ? 'scrolled' : 'paginated',
    manager: scrolled ? 'continuous' : 'default',
    spread: 'none',
    // MUST be true: epub.js runs a small bridge script *inside* each chapter
    // iframe to report selections/links back to us. With it false the iframe is
    // sandboxed without allow-scripts, so the `selected` event never fires and
    // highlighting silently breaks. Safe here — we only load the user's own EPUBs.
    allowScriptedContent: true,
  }
}

// Theme rules injected into every chapter's iframe so the book matches the app
// chrome (and never follows OS dark mode on its own).
export function themeRules(settings: Settings): object {
  const c = THEMES[settings.theme]
  const lh = String(settings.lineHeight)
  return {
    html: { background: `${c.bg} !important` },
    body: {
      background: `${c.bg} !important`,
      color: `${c.ink} !important`,
      'line-height': `${lh} !important`,
    },
    'p, li, blockquote, dd, h1, h2, h3, h4, h5, h6, span, div, td, th': {
      color: `${c.ink} !important`,
    },
    'p, li, blockquote, dd': { 'line-height': `${lh} !important` },
    'a, a:link, a:visited': { color: `${c.link} !important` },
    '::selection': { background: 'rgba(127,127,127,0.35)' },
  }
}

let comparator: ((a: string, b: string) => number) | null = null
export function getCFIComparator(): (a: string, b: string) => number {
  if (!comparator) {
    const cfi = new EpubCFI()
    comparator = (a: string, b: string) => {
      try {
        return cfi.compare(a, b)
      } catch {
        return a < b ? -1 : a > b ? 1 : 0
      }
    }
  }
  return comparator
}
