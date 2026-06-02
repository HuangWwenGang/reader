// VirtualReader — a custom virtual-scrolling continuous EPUB renderer.
//
// Why this exists: epub.js's continuous manager doesn't reserve placeholder
// heights for unrendered chapters, so the scroll height is unstable → position
// drift; and its "current location" is unreliable when reading forward. This
// engine fixes both:
//   • every chapter (rendered or not) contributes a height to one tall spacer,
//     so total scroll height is stable → no drift on exit/reopen;
//   • only chapters near the viewport get an <iframe> (recycled otherwise);
//   • the chapter at the viewport TOP is always mounted, so we can read a
//     line-precise CFI from it directly (no reliance on epub.js's guesswork);
//   • when a chapter's measured height differs from its estimate, we keep the
//     reader's anchor (what's at the viewport top) pinned — no visible jump.
//
// epub.js is still used for parsing (spine/resources/metadata) and CFI math.
import { EpubCFI } from 'epubjs'
import type { Settings } from './settings'
import { readerCss } from './epub'
import { getHeights, saveHeights } from './db'
import { rangeToAnchor, type AnchorRect } from './geometry'
import { colorForTag } from './tags'
import type { Highlight } from './types'

const BUFFER = 1.3 // render viewport ± this many screens of chapters
const SAVE_DEBOUNCE = 300

export interface RelocateInfo {
  cfi?: string
  percentage: number
  chapter?: string
}

interface MountedSection {
  slot: HTMLDivElement
  iframe: HTMLIFrameElement
  svg: SVGSVGElement
  doc: Document
  ro?: ResizeObserver
  measured: boolean
  loaded: Promise<void>
  drawn: { id: string; rects: DOMRect[] }[]
}

export interface VirtualReaderCallbacks {
  onRelocate?: (info: RelocateInfo) => void
  onSelected?: (info: { cfiRange: string; text: string; anchor: AnchorRect; doc: Document }) => void
  onHighlightClick?: (id: string, anchor: AnchorRect) => void
  onTap?: () => void
}

export class VirtualReader {
  private book: any
  private container: HTMLElement
  private settings: Settings
  private cb: VirtualReaderCallbacks

  private scroller!: HTMLDivElement
  private spacer!: HTMLDivElement
  private sections: any[] = []
  private heights: number[] = []
  private offsets: number[] = []
  private total = 0
  private estH = 1600
  private mounted = new Map<number, MountedSection>()
  private anchor = { index: 0, intra: 0 }
  private correcting = false
  private destroyed = false
  private saveTimer: number | null = null
  private rafPending = false
  private highlights: Highlight[] = []
  private toc: { href: string; label: string }[] = []

  constructor(
    book: any,
    container: HTMLElement,
    settings: Settings,
    cb: VirtualReaderCallbacks,
  ) {
    this.book = book
    this.container = container
    this.settings = settings
    this.cb = cb
  }

  private layoutKey() {
    const s = this.settings
    const w = Math.round(this.scroller?.clientWidth ?? this.container.clientWidth)
    return [
      this.book?.key?.() ?? '',
      s.fontScale,
      s.lineHeight,
      s.letterSpacing,
      s.margin,
      s.fontFamily,
      s.bold ? 1 : 0,
      w,
    ].join('|')
  }

  async start(bookId: string, startCfi?: string, highlights: Highlight[] = []) {
    this.highlights = highlights
    // DOM
    this.scroller = document.createElement('div')
    Object.assign(this.scroller.style, {
      position: 'absolute',
      inset: '0',
      overflowY: 'auto',
      overflowX: 'hidden',
      // momentum scrolling on iOS
      WebkitOverflowScrolling: 'touch',
    } as any)
    this.spacer = document.createElement('div')
    Object.assign(this.spacer.style, { position: 'relative', width: '100%' })
    this.scroller.appendChild(this.spacer)
    this.container.appendChild(this.scroller)

    await this.book.ready
    this.sections = []
    this.book.spine.each((s: any) => {
      if (s && s.linear !== false) this.sections.push(s)
    })
    // toc for chapter titles
    try {
      const nav = await this.book.loaded.navigation
      const flat: { href: string; label: string }[] = []
      const walk = (items: any[]) => {
        for (const it of items ?? []) {
          flat.push({ href: it.href, label: (it.label ?? '').trim() })
          if (it.subitems?.length) walk(it.subitems)
        }
      }
      walk(nav?.toc ?? [])
      this.toc = flat
    } catch {
      /* ignore */
    }

    this.estH = Math.max(800, Math.round(this.scroller.clientHeight * 1.4))
    this.bookId = bookId
    const cached = await getHeights(`${bookId}:${this.layoutKey()}`)
    this.heights = this.sections.map((_, i) =>
      cached && cached.length === this.sections.length ? cached[i] : this.estH,
    )
    this.recomputeOffsets(0)
    this.spacer.style.height = `${this.total}px`

    // restore position
    if (startCfi) {
      await this.goTo(startCfi, true)
    } else {
      this.anchor = { index: 0, intra: 0 }
      this.scroller.scrollTop = 0
      await this.update()
    }

    this.scroller.addEventListener('scroll', this.onScroll, { passive: true })
    this.emitRelocate()
  }

  private bookId = ''

  destroy() {
    this.destroyed = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.scroller?.removeEventListener('scroll', this.onScroll)
    for (const [, m] of this.mounted) this.unmountEl(m)
    this.mounted.clear()
    this.scroller?.remove()
  }

  // ---- geometry ----
  private recomputeOffsets(from: number) {
    let acc = from === 0 ? 0 : this.offsets[from]
    for (let i = from; i < this.sections.length; i++) {
      this.offsets[i] = acc
      acc += this.heights[i]
    }
    this.total = acc
  }

  private sectionAt(scrollTop: number) {
    // binary search the section containing scrollTop
    let lo = 0
    let hi = this.sections.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.offsets[mid] <= scrollTop) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  private onScroll = () => {
    if (this.correcting || this.destroyed) return
    if (!this.rafPending) {
      this.rafPending = true
      requestAnimationFrame(() => {
        this.rafPending = false
        const st = this.scroller.scrollTop
        const i = this.sectionAt(st)
        this.anchor = { index: i, intra: st - this.offsets[i] }
        this.update()
        this.scheduleRelocate()
      })
    }
  }

  private async update() {
    if (this.destroyed) return
    const st = this.scroller.scrollTop
    const vh = this.scroller.clientHeight
    const start = st - BUFFER * vh
    const end = st + vh + BUFFER * vh
    const need = new Set<number>()
    for (let i = 0; i < this.sections.length; i++) {
      const top = this.offsets[i]
      const bot = top + this.heights[i]
      if (bot > start && top < end) need.add(i)
    }
    // always keep the current chapter and its immediate neighbors mounted, so
    // moving to the next/previous chapter is seamless (already rendered) and
    // doesn't reload-flash when you scroll back.
    for (const k of [
      this.anchor.index - 1,
      this.anchor.index,
      this.anchor.index + 1,
    ]) {
      if (k >= 0 && k < this.sections.length) need.add(k)
    }
    // unmount no-longer-needed
    for (const [i, m] of this.mounted) {
      if (!need.has(i)) {
        this.unmountEl(m)
        this.mounted.delete(i)
      }
    }
    // mount needed
    for (const i of need) {
      if (!this.mounted.has(i)) this.mountSection(i)
    }
  }

  private unmountEl(m: MountedSection) {
    try {
      m.ro?.disconnect()
    } catch {
      /* ignore */
    }
    m.slot.remove()
  }

  private mountSection(i: number): Promise<void> {
    const section = this.sections[i]
    const slot = document.createElement('div')
    Object.assign(slot.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      top: `${this.offsets[i]}px`,
      height: `${this.heights[i]}px`,
    })
    const iframe = document.createElement('iframe')
    Object.assign(iframe.style, {
      width: '100%',
      height: '100%',
      border: '0',
      display: 'block',
    })
    iframe.setAttribute('scrolling', 'no')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    Object.assign(svg.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    } as any)
    slot.appendChild(iframe)
    slot.appendChild(svg)
    this.spacer.appendChild(slot)

    const m: MountedSection = {
      slot,
      iframe,
      svg,
      doc: null as any,
      measured: false,
      loaded: null as any,
      drawn: [],
    }
    this.mounted.set(i, m)

    m.loaded = new Promise<void>((resolve) => {
      const onload = () => {
        const doc = iframe.contentDocument
        if (!doc) return resolve()
        m.doc = doc
        // theme
        this.injectCss(doc)
        this.wireDoc(i, doc)
        // measure (after fonts settle)
        const measure = () => this.measure(i)
        measure()
        try {
          ;(doc as any).fonts?.ready?.then(measure)
        } catch {
          /* ignore */
        }
        try {
          m.ro = new ResizeObserver(() => this.measure(i))
          m.ro.observe(doc.documentElement)
        } catch {
          /* ignore */
        }
        this.drawHighlights(i)
        resolve()
      }
      iframe.addEventListener('load', onload, { once: true })
      // render section HTML and inject via srcdoc (iOS-safe)
      Promise.resolve(section.render(this.book.load.bind(this.book)))
        .then((html: string) => {
          if (this.destroyed) return
          iframe.srcdoc = html
        })
        .catch(() => resolve())
    })
    return m.loaded
  }

  private injectCss(doc: Document) {
    try {
      let style = doc.getElementById('vr-theme') as HTMLStyleElement | null
      if (!style) {
        style = doc.createElement('style')
        style.id = 'vr-theme'
        doc.head?.appendChild(style)
      }
      style.textContent = readerCss(this.settings)
    } catch {
      /* ignore */
    }
  }

  private wireDoc(i: number, doc: Document) {
    let selTimer: number | undefined
    doc.addEventListener('selectionchange', () => {
      clearTimeout(selTimer)
      selTimer = window.setTimeout(() => this.handleSelection(i, doc), 220)
    })
    doc.addEventListener('click', (e: MouseEvent) => this.handleClick(i, doc, e))
  }

  private handleSelection(i: number, doc: Document) {
    const sel = doc.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const text = sel.toString().trim()
    if (!text) return
    let cfiRange: string
    try {
      cfiRange = this.sections[i].cfiFromRange(range)
    } catch {
      return
    }
    const anchor = rangeToAnchor(doc, range)
    if (!anchor) return
    try {
      sel.removeAllRanges()
    } catch {
      /* ignore */
    }
    this.cb.onSelected?.({ cfiRange, text, anchor, doc })
  }

  private handleClick(i: number, doc: Document, e: MouseEvent) {
    const sel = doc.getSelection()
    if (sel && !sel.isCollapsed) return
    if ((e.target as HTMLElement)?.closest?.('a[href]')) return
    // hit-test highlights in this section
    const m = this.mounted.get(i)
    if (m) {
      for (let k = m.drawn.length - 1; k >= 0; k--) {
        const d = m.drawn[k]
        for (const r of d.rects) {
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            const h = this.highlights.find((x) => x.id === d.id)
            if (h) {
              const anchor = this.anchorForCfi(h.cfi) ?? {
                centerX: e.clientX,
                top: e.clientY,
                bottom: e.clientY,
              }
              this.cb.onHighlightClick?.(d.id, anchor)
              return
            }
          }
        }
      }
    }
    this.cb.onTap?.()
  }

  private measure(i: number) {
    const m = this.mounted.get(i)
    if (!m || !m.doc) return
    // IMPORTANT: use body.scrollHeight (real content height). documentElement
    // .scrollHeight returns the iframe's own (estimated) height on iOS, which
    // left a huge blank tail after short chapters and inflated total/scrollbar.
    const body = m.doc.body
    const h = Math.max(
      body?.scrollHeight ?? 0,
      body?.getBoundingClientRect().height ?? 0,
      40,
    )
    if (Math.abs(h - this.heights[i]) < 1) {
      if (!m.measured) {
        m.measured = true
        this.maybeCacheHeights()
      }
      return
    }
    const delta = h - this.heights[i]
    this.heights[i] = h
    m.slot.style.height = `${h}px`
    m.measured = true
    this.recomputeOffsets(i + 1)
    this.spacer.style.height = `${this.total}px`
    // reposition mounted sections after i
    for (const [j, mj] of this.mounted) {
      if (j > i) mj.slot.style.top = `${this.offsets[j]}px`
    }
    // anchor correction: keep what's at the viewport top pinned
    if (this.offsets[i] < this.scroller.scrollTop || (this.anchor.index === i && delta)) {
      this.correcting = true
      this.scroller.scrollTop = this.offsets[this.anchor.index] + this.anchor.intra
      this.correcting = false
    }
    this.drawHighlights(i)
    this.maybeCacheHeights()
    // a height change may reveal/hide sections
    this.update()
  }

  private cacheTimer: number | null = null
  private maybeCacheHeights() {
    if (this.cacheTimer) clearTimeout(this.cacheTimer)
    this.cacheTimer = window.setTimeout(() => {
      // only cache once all sections have a measured value at least once is too
      // strict; cache the current snapshot (estimates fill the gaps, corrected
      // over time). Good enough and improves subsequent opens.
      saveHeights(`${this.bookId}:${this.layoutKey()}`, this.heights.slice()).catch(
        () => {},
      )
    }, 1500)
  }

  // ---- position / relocate ----
  private scheduleRelocate() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.emitRelocate(), SAVE_DEBOUNCE)
  }

  // CFI of the content at the viewport top. Uses REAL screen geometry (iframe
  // getBoundingClientRect) instead of the offsets bookkeeping, and validates
  // caretRangeFromPoint (it clamps/fails on tall not-yet-measured iframes — the
  // cause of the large-book "forward read not recorded" bug); falls back to a
  // block-element scan so a section that just mounted still yields a position.
  currentCfi(): string | undefined {
    if (!this.scroller) return undefined
    const probeY = this.scroller.getBoundingClientRect().top + 2
    for (const [i, m] of this.mounted) {
      if (!m.doc) continue
      const fr = m.iframe.getBoundingClientRect()
      if (fr.top - 1 > probeY || fr.bottom <= probeY) continue
      // this is the section at the viewport top
      const localY = probeY - fr.top
      let range: Range | null = null
      try {
        const x = Math.max(24, Math.min(m.doc.documentElement.clientWidth / 2, 320))
        const r = (m.doc as any).caretRangeFromPoint?.(x, localY) as Range | null
        if (r) {
          const rr = r.getBoundingClientRect()
          // only trust it if the resolved point is actually near the probe
          if (Math.abs(rr.top + fr.top - probeY) < 240) range = r
        }
      } catch {
        /* ignore */
      }
      if (!range) range = this.rangeFromScreenY(m.doc, probeY)
      if (range) {
        try {
          return this.sections[i].cfiFromRange(range)
        } catch {
          return undefined
        }
      }
      return undefined
    }
    return undefined
  }

  private rangeFromScreenY(doc: Document, screenY: number): Range | null {
    const blocks = doc.body?.querySelectorAll(
      'p,li,blockquote,h1,h2,h3,h4,h5,h6,pre,figure,img,td',
    )
    if (!blocks) return null
    let crossing: Element | null = null
    let crossingTop = -Infinity
    let firstBelow: Element | null = null
    for (const el of Array.from(blocks)) {
      const r = (el as HTMLElement).getBoundingClientRect()
      if (r.height < 1) continue
      if (r.top <= screenY && r.bottom > screenY) {
        if (r.top > crossingTop) {
          crossing = el
          crossingTop = r.top
        }
      } else if (r.top > screenY && !firstBelow) {
        firstBelow = el
      }
    }
    const el = crossing ?? firstBelow
    if (!el) return null
    try {
      const range = doc.createRange()
      range.selectNodeContents(el)
      range.collapse(true)
      return range
    } catch {
      return null
    }
  }

  private emitRelocate() {
    const cfi = this.currentCfi()
    const percentage =
      this.total > 0 ? this.scroller.scrollTop / this.total : 0
    const chapter = this.chapterTitleFor(this.anchor.index)
    this.cb.onRelocate?.({ cfi, percentage, chapter })
  }

  private chapterTitleFor(i: number): string | undefined {
    // find the toc entry whose section <= i (closest preceding)
    const href = this.sections[i]?.href ?? ''
    const base = href.split('#')[0].split('/').pop() ?? ''
    let best: string | undefined
    for (const t of this.toc) {
      const th = (t.href ?? '').split('#')[0].split('/').pop() ?? ''
      if (th && th === base) return t.label
    }
    return best
  }

  // ---- navigation ----
  async goTo(target: string, isInitial = false): Promise<void> {
    let section: any
    try {
      section = this.book.spine.get(target)
    } catch {
      section = null
    }
    if (!section) return
    const i = this.sections.findIndex((s) => s.index === section.index)
    if (i < 0) return
    // Mount the target section (off-screen) and LOAD it first, so we can compute
    // the exact final scroll position in ONE step — no "jump to chapter top then
    // correct" flicker.
    if (!this.mounted.has(i)) this.mountSection(i)
    const m = this.mounted.get(i)
    if (m) {
      try {
        await m.loaded
      } catch {
        /* ignore */
      }
    }
    let intra = 0
    if (m?.doc) {
      if (target.startsWith('epubcfi(')) {
        try {
          const range = new EpubCFI(target).toRange(m.doc)
          if (range) intra = Math.max(0, range.getBoundingClientRect().top)
        } catch {
          /* ignore */
        }
      } else if (target.includes('#')) {
        // TOC sub-items (2.1, 2.2, …) usually share the chapter file and differ
        // only by an in-page anchor (#id). Resolve that anchor to its element.
        const frag = target.slice(target.indexOf('#') + 1)
        let el: Element | null = null
        try {
          el =
            m.doc.getElementById(decodeURIComponent(frag)) ??
            m.doc.getElementById(frag) ??
            m.doc.querySelector(`[name="${frag}"]`)
        } catch {
          el = null
        }
        if (el) intra = Math.max(0, (el as HTMLElement).getBoundingClientRect().top)
      }
    }
    this.anchor = { index: i, intra }
    this.correcting = true
    this.scroller.scrollTop = this.offsets[i] + intra
    this.correcting = false
    await this.update()
    if (!isInitial) this.emitRelocate()
  }

  // ---- settings / theme ----
  async applySettings(settings: Settings) {
    const old = this.settings
    this.settings = settings
    const layoutChanged =
      old.fontScale !== settings.fontScale ||
      old.lineHeight !== settings.lineHeight ||
      old.letterSpacing !== settings.letterSpacing ||
      old.margin !== settings.margin ||
      old.fontFamily !== settings.fontFamily ||
      old.bold !== settings.bold
    for (const [i, m] of this.mounted) {
      if (m.doc) this.injectCss(m.doc)
      if (layoutChanged) m.measured = false
      void i
    }
    if (layoutChanged) {
      // heights will be re-measured; load cache for the new layout if present
      const cached = await getHeights(`${this.bookId}:${this.layoutKey()}`)
      if (cached && cached.length === this.sections.length) {
        this.heights = cached.slice()
        this.recomputeOffsets(0)
        this.spacer.style.height = `${this.total}px`
        for (const [j, mj] of this.mounted) mj.slot.style.top = `${this.offsets[j]}px`
        this.correcting = true
        this.scroller.scrollTop = this.offsets[this.anchor.index] + this.anchor.intra
        this.correcting = false
      }
      // re-measure mounted sections (will anchor-correct)
      for (const [i] of this.mounted) this.measure(i)
    }
  }

  // ---- highlights ----
  setHighlights(hs: Highlight[]) {
    this.highlights = hs
    for (const [i] of this.mounted) this.drawHighlights(i)
  }

  redrawCfi(_cfi: string) {
    for (const [i] of this.mounted) this.drawHighlights(i)
  }

  private drawHighlights(i: number) {
    const m = this.mounted.get(i)
    if (!m || !m.doc) return
    const NS = 'http://www.w3.org/2000/svg'
    while (m.svg.firstChild) m.svg.removeChild(m.svg.firstChild)
    m.drawn = []
    const base = (this.sections[i].href ?? '').split('#')[0]
    for (const h of this.highlights) {
      // cheap pre-filter: cfi belongs to this section?
      if (!this.cfiInSection(h.cfi, i)) continue
      let range: Range | null = null
      try {
        range = new EpubCFI(h.cfi).toRange(m.doc)
      } catch {
        range = null
      }
      if (!range) continue
      const rects = Array.from(range.getClientRects()) as DOMRect[]
      if (!rects.length) continue
      const g = document.createElementNS(NS, 'g')
      g.setAttribute('fill', colorForTag(h.tag))
      g.setAttribute('fill-opacity', '0.3')
      for (const r of rects) {
        const rect = document.createElementNS(NS, 'rect')
        rect.setAttribute('x', String(r.left))
        rect.setAttribute('y', String(r.top))
        rect.setAttribute('width', String(r.width))
        rect.setAttribute('height', String(r.height))
        g.appendChild(rect)
      }
      m.svg.appendChild(g)
      m.drawn.push({ id: h.id, rects })
      void base
    }
  }

  private cfiInSection(cfi: string, i: number): boolean {
    // compare the spine-step prefix of the cfi to the section's cfiBase
    try {
      const base = this.sections[i].cfiBase as string // e.g. /6/14[id]
      const stepCfi = cfi.match(/^epubcfi\((\/\d+\/\d+)/)?.[1]
      const stepBase = base.match(/^(\/\d+\/\d+)/)?.[1]
      return !!stepCfi && !!stepBase && stepCfi === stepBase
    } catch {
      return false
    }
  }

  private anchorForCfi(cfi: string): AnchorRect | null {
    for (const [i, m] of this.mounted) {
      if (!m.doc || !this.cfiInSection(cfi, i)) continue
      try {
        const range = new EpubCFI(cfi).toRange(m.doc)
        if (range) return rangeToAnchor(m.doc, range)
      } catch {
        /* ignore */
      }
    }
    return null
  }
}
