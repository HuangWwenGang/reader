// Wrapper around epub.js. We use its `continuous` manager + `scrolled` flow to
// get true seamless infinite scrolling across chapters (foliate rendered one
// chapter at a time, which can't be seamless).
import ePub, { Book, EpubCFI } from 'epubjs'
import type { RenditionOptions } from 'epubjs/types/rendition'
import type { Settings } from './settings'
import { FONTS, THEMES, nightInk } from './settings'

export type { Book }

// Open a Book from raw EPUB bytes. We slice a copy so the stored ArrayBuffer is
// never mutated/detached by JSZip across repeated opens.
export function openBookFromBuffer(buf: ArrayBuffer): Book {
  return ePub(buf.slice(0))
}

export interface BookMeta {
  title: string
  author?: string
  cover?: ArrayBuffer | null
}

// Parse an EPUB just enough for the shelf (title/author/cover).
export async function extractMeta(buf: ArrayBuffer): Promise<BookMeta> {
  const book = ePub(buf.slice(0))
  try {
    await book.ready
    const meta = await book.loaded.metadata
    const title = meta?.title || '未命名书籍'
    const author = (meta?.creator as string) || undefined
    let cover: ArrayBuffer | null = null
    try {
      const url = await book.coverUrl()
      if (url) cover = await (await fetch(url)).arrayBuffer()
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
  // night text brightness is user-adjustable
  const ink = settings.theme === 'night' ? nightInk(settings.brightness) : c.ink
  const lh = String(settings.lineHeight)
  const ls = `${settings.letterSpacing}em`
  const align = settings.justify ? 'justify' : 'start'
  const font = FONTS[settings.fontFamily]
  const fontRule = font ? { 'font-family': `${font} !important` } : {}
  const weightRule = settings.bold ? { 'font-weight': '600 !important' } : {}
  return {
    html: { background: `${c.bg} !important` },
    body: {
      background: `${c.bg} !important`,
      color: `${ink} !important`,
      'line-height': `${lh} !important`,
      'letter-spacing': `${ls} !important`,
      // horizontal reading margin
      'padding-left': `${settings.margin}% !important`,
      'padding-right': `${settings.margin}% !important`,
      ...fontRule,
      ...weightRule,
    },
    'p, li, blockquote, dd, h1, h2, h3, h4, h5, h6, span, div, td, th': {
      color: `${ink} !important`,
      ...fontRule,
    },
    'p, li, blockquote, dd': {
      'line-height': `${lh} !important`,
      'letter-spacing': `${ls} !important`,
      'text-align': `${align} !important`,
      ...weightRule,
    },
    'a, a:link, a:visited': { color: `${c.link} !important` },
    '::selection': { background: 'rgba(140,140,140,0.4)' },
  }
}

// Reduce continuous-scroll stutter. By default epub.js DESTROYS each section as
// soon as it scrolls off-screen, so scrolling back (or scrolling fast) reloads
// it → blank flash. We override the manager to keep recently-read sections
// rendered, only erasing ones far outside a window (±KEEP). Trades memory for
// smoothness. Heavily guarded so a different epub.js build just falls back.
export function tuneContinuous(rendition: any): void {
  try {
    const m = rendition?.manager
    if (!m || typeof m.update !== 'function' || !m.views) return
    const KEEP = 6
    if (m.settings) m.settings.offset = 1200 // render a bit further ahead/behind

    m.update = function (this: any, _offset?: number) {
      const container = this.bounds()
      const views = this.views.all()
      const offset =
        typeof _offset !== 'undefined' ? _offset : this.settings.offset || 0
      const promises: any[] = []
      for (const view of views) {
        const isVisible = this.isVisible(view, offset, offset, container)
        if (isVisible) {
          if (!view.displayed) {
            promises.push(
              view.display(this.request).then(
                (v: any) => v.show(),
                () => view.hide(),
              ),
            )
          } else {
            view.show()
          }
        }
        // NOTE: intentionally do NOT destroy non-visible views — keep them
        // rendered so scrolling back is instant (no reload flash).
      }
      clearTimeout(this.trimTimeout)
      this.trimTimeout = setTimeout(
        () => this.q.enqueue(this.trim.bind(this)),
        500,
      )
      return promises.length
        ? Promise.all(promises).catch(() => {})
        : Promise.resolve()
    }

    m.trim = function (this: any) {
      const displayed = this.views.displayed()
      if (!displayed.length) return Promise.resolve()
      const all = this.views.all()
      const first = this.views.indexOf(displayed[0])
      const last = this.views.indexOf(displayed[displayed.length - 1])
      for (let i = 0; i < all.length; i++) {
        if (i < first - KEEP || i > last + KEEP) {
          try {
            this.erase(all[i])
          } catch {
            /* ignore */
          }
        }
      }
      return Promise.resolve()
    }
  } catch (e) {
    console.warn('tuneContinuous failed (using default)', e)
  }
}

// CSS string (for injecting a <style> into a section iframe in the virtual
// scroller). Same look as themeRules but serialized.
export function readerCss(settings: Settings): string {
  const c = THEMES[settings.theme]
  const ink = settings.theme === 'night' ? nightInk(settings.brightness) : c.ink
  const font = FONTS[settings.fontFamily]
  const fontDecl = font ? `font-family:${font} !important;` : ''
  const weightDecl = settings.bold ? 'font-weight:600 !important;' : ''
  const align = settings.justify ? 'justify' : 'start'
  return `
    html { background:${c.bg} !important; color-scheme: light; height:auto !important; }
    body {
      background:${c.bg} !important; color:${ink} !important;
      margin:0 !important; height:auto !important;
      padding:${settings.margin}% ${settings.margin}% 6% !important;
      line-height:${settings.lineHeight} !important;
      letter-spacing:${settings.letterSpacing}em !important;
      font-size:${settings.fontScale}% !important;
      ${fontDecl}${weightDecl}
      -webkit-text-size-adjust:100% !important;
    }
    p,li,blockquote,dd,h1,h2,h3,h4,h5,h6,span,div,td,th,a { color:${ink} !important; ${fontDecl} }
    p,li,blockquote,dd { line-height:${settings.lineHeight} !important; letter-spacing:${settings.letterSpacing}em !important; text-align:${align} !important; ${weightDecl} }
    a,a:link,a:visited { color:${c.link} !important; }
    img,svg,video { max-width:100% !important; height:auto !important; }
    ::selection { background: rgba(140,140,140,0.4); }
    pre { white-space: pre-wrap !important; }
  `
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
