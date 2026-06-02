// VirtualReader v2 — flow-based windowed continuous reader.
//
// v1 absolutely-positioned each chapter and hand-computed offsets, which was
// fragile with async images (heights changed after layout → overlap/blank).
//
// v2 stacks the loaded chapters in NORMAL DOCUMENT FLOW inside a scroller. The
// browser lays them out, so:
//   • chapters can NEVER overlap (flow layout) — fixes the overlap bug;
//   • when an image loads and a chapter grows, the browser reflows the ones
//     below automatically — fixes the blank/overlap without manual math.
// We only keep a window of chapters around the viewport (append/prepend at the
// edges, recycle far ones) so memory stays small even for 1000-page books.
// On prepend / above-viewport growth we adjust scrollTop to keep the view put.
//
// Whole-book progress % comes from epub.js `book.locations` (independent of the
// windowed scroll). epub.js still does parsing + CFI.
import { EpubCFI } from 'epubjs'
import type { Settings } from './settings'
import { THEMES } from './settings'
import { readerCss } from './epub'
import { getHeights, getHeightsComplete, saveHeights } from './db'
import { rangeToAnchor, type AnchorRect } from './geometry'
import { colorForTag } from './tags'
import type { Highlight } from './types'

const BUFFER = 1.6 // load/keep chapters within ±this many screens of the viewport
const RECYCLE = 2.6 // recycle chapters beyond ±this many screens
const SAVE_DEBOUNCE = 300
// Bump when readerCss changes the rendered metrics (weight/tracking/etc.) so old
// height caches — measured with the previous CSS — are invalidated instead of
// silently feeding wrong heights (which causes mid-read scroll corrections).
const CSS_VERSION = 2

export interface RelocateInfo {
  cfi?: string
  percentage: number
  chapter?: string
}

interface Mounted {
  index: number
  el: HTMLDivElement
  iframe: HTMLIFrameElement
  svg: SVGSVGElement
  doc: Document | null
  ro?: ResizeObserver
  loaded: Promise<void>
  drawn: { id: string; rects: DOMRect[] }[]
  measured?: boolean // has had its first real (content) measure
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
  private sections: any[] = []
  private heights: number[] = []
  private estH = 1600
  private mounted = new Map<number, Mounted>()
  private firstLoaded = 0
  private lastLoaded = -1
  private anchorIndex = 0
  private correcting = false
  private destroyed = false
  private rafPending = false
  // While the user is actively scrolling we must NOT set scrollTop (on iOS that
  // fights the momentum and teleports the view). Height corrections that would
  // move scrollTop are deferred here and applied once scrolling settles.
  private isScrolling = false
  private scrollIdle: number | null = null
  private pendingMeasure = new Set<number>()
  private saveTimer: number | null = null
  private highlights: Highlight[] = []
  private toc: { href: string; label: string }[] = []
  private bookId = ''
  private fromCache = false
  private cacheComplete = false

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
      s.fontScale, s.lineHeight, s.letterSpacing, s.margin, s.fontFamily,
      s.bold ? 1 : 0, w, `v${CSS_VERSION}`,
    ].join('|')
  }

  async start(bookId: string, startCfi?: string, highlights: Highlight[] = []) {
    this.highlights = highlights
    this.bookId = bookId
    this.scroller = document.createElement('div')
    Object.assign(this.scroller.style, {
      position: 'absolute', inset: '0', overflowY: 'auto', overflowX: 'hidden',
      // themed backdrop so any momentary gap shows the page color, never white
      background: THEMES[this.settings.theme].bg,
      // hardware-accelerated momentum scrolling. The at-rest crispness comes
      // from whole-pixel layout (Math.ceil heights), so we keep this for smooth
      // flings; any softening only happens mid-scroll, which you can't read.
      WebkitOverflowScrolling: 'touch',
    } as any)
    this.container.appendChild(this.scroller)

    await this.book.ready
    this.sections = []
    this.book.spine.each((s: any) => {
      if (s && s.linear !== false) this.sections.push(s)
    })
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
    const cached = await getHeights(`${bookId}:${this.layoutKey()}`)
    this.fromCache = !!(cached && cached.length === this.sections.length)
    this.cacheComplete = this.fromCache && (await getHeightsComplete(`${bookId}:${this.layoutKey()}`))
    this.heights = this.sections.map((_, i) => (this.fromCache ? cached![i] : this.estH))

    // initial chapter
    let i0 = 0
    let intra = 0
    if (startCfi) {
      try {
        const sec = this.book.spine.get(startCfi)
        const k = this.sections.findIndex((s) => s.index === sec?.index)
        if (k >= 0) i0 = k
      } catch {
        /* ignore */
      }
    }
    this.firstLoaded = i0
    this.lastLoaded = i0 - 1
    this.appendBottom(i0)
    const m = this.mounted.get(i0)!
    try {
      await m.loaded
    } catch {
      /* ignore */
    }
    if (startCfi && startCfi.startsWith('epubcfi(') && m.doc) {
      try {
        const range = new EpubCFI(startCfi).toRange(m.doc)
        if (range) intra = Math.max(0, range.getBoundingClientRect().top)
      } catch {
        /* ignore */
      }
    }
    this.correcting = true
    this.scroller.scrollTop = intra
    this.correcting = false
    this.anchorIndex = i0
    this.fillWindow()

    this.scroller.addEventListener('scroll', this.onScroll, { passive: true })
    this.emitRelocate()

    // Run the whole-book premeasure unless we already have a COMPLETE cache.
    // A partial cache (premeasure interrupted last time) still has estimates for
    // un-reached chapters → they'd drift on arrival, so finish the job.
    if (!this.cacheComplete) {
      const kick = () => this.premeasureAll()
      const ric = (window as any).requestIdleCallback
      if (typeof ric === 'function') ric(kick, { timeout: 2500 })
      else window.setTimeout(kick, 1000)
    }
  }

  destroy() {
    this.destroyed = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.scrollIdle) clearTimeout(this.scrollIdle)
    this.scroller?.removeEventListener('scroll', this.onScroll)
    for (const [, m] of this.mounted) {
      try {
        m.ro?.disconnect()
      } catch {
        /* ignore */
      }
    }
    this.mounted.clear()
    this.scroller?.remove()
  }

  // ---- mounting (flow layout) ----
  private makeSection(i: number): Mounted {
    const el = document.createElement('div')
    Object.assign(el.style, {
      position: 'relative',
      width: '100%',
      height: `${this.heights[i]}px`,
      overflow: 'hidden',
      // themed backdrop shows while the iframe is still hidden (loading), so the
      // section is never a white rectangle
      background: THEMES[this.settings.theme].bg,
    })
    const iframe = document.createElement('iframe')
    Object.assign(iframe.style, {
      width: '100%', height: '100%', border: '0', display: 'block',
      // hidden until the real chapter content is in — avoids the white
      // about:blank flash (the "flicker") before srcdoc paints
      visibility: 'hidden',
    })
    iframe.setAttribute('scrolling', 'no')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    Object.assign(svg.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none',
    } as any)
    el.appendChild(iframe)
    el.appendChild(svg)
    const m: Mounted = { index: i, el, iframe, svg, doc: null, loaded: null as any, drawn: [] }
    m.loaded = new Promise<void>((resolve) => {
      let wired = false
      iframe.addEventListener(
        'load',
        () => {
          // srcdoc first fires `load` for the initial empty document; only bind
          // once the real chapter content is actually present.
          const doc = iframe.contentDocument
          if (!doc) return
          const hasContent =
            !!doc.body && (doc.body.childElementCount > 0 || (doc.body.textContent ?? '').trim().length > 0)
          if (!hasContent || wired) return
          wired = true
          m.doc = doc
          this.injectCss(doc)
          iframe.style.visibility = 'visible'
          this.wireDoc(i, doc)
          const remeasure = () => this.measure(i)
          requestAnimationFrame(remeasure)
          try {
            ;(doc as any).fonts?.ready?.then(remeasure)
          } catch {
            /* ignore */
          }
          try {
            for (const img of Array.from(doc.querySelectorAll('img'))) {
              if (!(img as HTMLImageElement).complete) {
                img.addEventListener('load', remeasure, { once: true })
                img.addEventListener('error', remeasure, { once: true })
              }
            }
            doc.defaultView?.addEventListener('load', remeasure, { once: true })
          } catch {
            /* ignore */
          }
          for (const t of [150, 600, 1600, 3500]) window.setTimeout(remeasure, t)
          try {
            m.ro = new ResizeObserver(remeasure)
            m.ro.observe(doc.body ?? doc.documentElement)
          } catch {
            /* ignore */
          }
          this.drawHighlights(i)
          resolve()
        },
      )
      Promise.resolve(this.sections[i].render(this.book.load.bind(this.book)))
        .then((html: string) => {
          if (!this.destroyed) iframe.srcdoc = html
        })
        .catch(() => resolve())
    })
    this.mounted.set(i, m)
    return m
  }

  private appendBottom(i: number) {
    const m = this.makeSection(i)
    this.scroller.appendChild(m.el)
    this.lastLoaded = i
  }

  private prependTop(i: number) {
    const m = this.makeSection(i)
    this.scroller.insertBefore(m.el, this.scroller.firstChild)
    // keep the view stable: content was added above by heights[i]
    this.correcting = true
    this.scroller.scrollTop += this.heights[i]
    this.correcting = false
    this.firstLoaded = i
  }

  private removeSection(i: number, fromTop: boolean) {
    const m = this.mounted.get(i)
    if (!m) return
    const h = m.el.offsetHeight
    try {
      m.ro?.disconnect()
    } catch {
      /* ignore */
    }
    m.el.remove()
    this.mounted.delete(i)
    if (fromTop) {
      // content removed above → shift view up to compensate
      this.correcting = true
      this.scroller.scrollTop -= h
      this.correcting = false
    }
  }

  private fillScheduled = false
  private scheduleFill() {
    if (this.fillScheduled || this.destroyed || !this.scroller) return
    this.fillScheduled = true
    requestAnimationFrame(() => {
      this.fillScheduled = false
      this.fillWindow()
    })
  }

  // Do AT MOST ONE mount/recycle per call, then reschedule on the next frame if
  // more is needed. This spreads iframe creation across frames so re-reading
  // backward never renders a dozen chapters at once (the 1–2s freeze). Priority:
  // append-below → prepend-above → recycle. Append/prepend run during scrolling
  // (prepend is what makes back-reading load); recycle-above is deferred while
  // scrolling because it writes scrollTop (iOS momentum teleport).
  private fillWindow() {
    if (this.destroyed || !this.scroller) return
    const sc = this.scroller
    const vh = sc.clientHeight
    const N = this.sections.length
    const rect = sc.getBoundingClientRect()

    // 1. append below — no scrollTop change, safe anytime
    if (this.lastLoaded < N - 1 && sc.scrollHeight - (sc.scrollTop + vh) < BUFFER * vh) {
      this.appendBottom(this.lastLoaded + 1)
      return this.scheduleFill()
    }
    // 2. prepend above — writes scrollTop, but needed so back-reading loads; at
    //    most one per frame keeps it cheap (no freeze)
    if (this.firstLoaded > 0 && sc.scrollTop < BUFFER * vh) {
      this.prependTop(this.firstLoaded - 1)
      return this.scheduleFill()
    }
    // 3. recycle far below — fromTop=false, no scrollTop change → safe anytime
    if (this.lastLoaded > this.anchorIndex + 1) {
      const m = this.mounted.get(this.lastLoaded)
      if (m && m.el.getBoundingClientRect().top > rect.bottom + RECYCLE * vh) {
        this.removeSection(this.lastLoaded, false)
        this.lastLoaded--
        return this.scheduleFill()
      }
    }
    // 4. recycle far above — writes scrollTop → only when the scroll has settled
    if (!this.isScrolling && this.firstLoaded < this.anchorIndex - 1) {
      const m = this.mounted.get(this.firstLoaded)
      if (m && m.el.getBoundingClientRect().bottom < rect.top - RECYCLE * vh) {
        this.removeSection(this.firstLoaded, true)
        this.firstLoaded++
        return this.scheduleFill()
      }
    }
  }

  private measure(i: number) {
    const m = this.mounted.get(i)
    if (!m || !m.doc) return
    // round UP to a whole pixel: a fractional section height would place every
    // chapter below it on a sub-pixel row, so the browser rasterizes the text
    // with interpolation → the slight "fuzzy / not as crisp as native" look.
    const h = Math.ceil(
      Math.max(
        m.doc.body?.scrollHeight ?? 0,
        m.doc.body?.getBoundingClientRect().height ?? 0,
        40,
      ),
    )
    if (Math.abs(h - this.heights[i]) < 1) {
      m.measured = true
      return
    }
    const scTop = this.scroller.getBoundingClientRect().top
    const r = m.el.getBoundingClientRect()
    const offsetInto = scTop - r.top // viewport top, measured from this section's top
    const wouldMoveScroll = r.bottom <= scTop + 1 || (!m.measured && offsetInto > h + 8)
    if (wouldMoveScroll && this.isScrolling) {
      // Defer: setting scrollTop now would fight the momentum and teleport the
      // page. Apply once the scroll settles (flushPendingMeasures), anchored so
      // the reading position is preserved. Height is left unchanged for now.
      this.pendingMeasure.add(i)
      return
    }
    const delta = h - this.heights[i]
    this.heights[i] = h
    m.el.style.height = `${h}px`
    if (r.bottom <= scTop + 1) {
      // chapter is entirely ABOVE the viewport: the reflow pushed everything
      // below by `delta`; counter it exactly so the page doesn't move. (This is
      // the original, drift-free behavior.)
      this.correcting = true
      this.scroller.scrollTop += delta
      this.correcting = false
    } else if (!m.measured && offsetInto > h + 8) {
      // FIRST measure of this chapter, and the viewport top was stranded in its
      // over-estimated tail (below where the real content ends). Pull the
      // chapter start to the top so the reader sees the heading first instead of
      // landing mid-chapter. Guarded by `measured` so a small late re-measure
      // while reading never yanks the view.
      this.correcting = true
      this.scroller.scrollTop = m.el.offsetTop
      this.correcting = false
    }
    // when the viewport top is WITHIN this chapter's content, do nothing: its
    // content is top-anchored, only the box tail changed → nothing visible moves.
    m.measured = true
    this.drawHighlights(i)
    this.scheduleCache()
    this.fillWindow()
  }

  // ---- scroll / position ----
  private onScroll = () => {
    if (this.correcting || this.destroyed) return
    // mark "actively scrolling"; clears a short beat after the last scroll event
    this.isScrolling = true
    if (this.scrollIdle) clearTimeout(this.scrollIdle)
    this.scrollIdle = window.setTimeout(() => {
      this.isScrolling = false
      this.flushPendingMeasures()
      this.fillWindow() // run deferred recycle-above now that scrolling stopped
    }, 160)
    if (this.rafPending) return
    this.rafPending = true
    requestAnimationFrame(() => {
      this.rafPending = false
      this.updateAnchor()
      this.fillWindow()
      this.scheduleRelocate()
    })
  }

  // Apply height corrections that were deferred during scrolling, now that the
  // scroll has settled and touching scrollTop is safe again. measure() handles
  // the exact above-the-viewport compensation / snap itself.
  private flushPendingMeasures() {
    if (this.pendingMeasure.size === 0 || this.destroyed) return
    const ids = [...this.pendingMeasure].sort((a, b) => a - b)
    this.pendingMeasure.clear()
    for (const i of ids) this.measure(i)
  }

  private updateAnchor() {
    const probeY = this.scroller.getBoundingClientRect().top + 2
    for (const [i, m] of this.mounted) {
      const r = m.el.getBoundingClientRect()
      if (r.top - 1 <= probeY && r.bottom > probeY) {
        this.anchorIndex = i
        return
      }
    }
  }

  currentCfi(): string | undefined {
    if (!this.scroller) return undefined
    const probeY = this.scroller.getBoundingClientRect().top + 2
    for (const [i, m] of this.mounted) {
      if (!m.doc) continue
      const fr = m.iframe.getBoundingClientRect()
      if (fr.top - 1 > probeY || fr.bottom <= probeY) continue
      const localY = probeY - fr.top
      let range: Range | null = null
      try {
        const x = Math.max(24, Math.min(m.doc.documentElement.clientWidth / 2, 320))
        const r = (m.doc as any).caretRangeFromPoint?.(x, localY) as Range | null
        if (r) {
          const rr = r.getBoundingClientRect()
          if (Math.abs(rr.top + fr.top - probeY) < 240) range = r
        }
      } catch {
        /* ignore */
      }
      // fallback uses the iframe-CONTENT y (localY), not the screen y
      if (!range) range = this.rangeFromContentY(m.doc, localY)
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

  private rangeFromContentY(doc: Document, y: number): Range | null {
    const blocks = doc.body?.querySelectorAll(
      'p,li,blockquote,h1,h2,h3,h4,h5,h6,pre,figure,img,td',
    )
    if (!blocks) return null
    let crossing: Element | null = null
    let crossingTop = -Infinity
    let firstBelow: Element | null = null
    for (const el of Array.from(blocks)) {
      // getBoundingClientRect inside the iframe == content coords (no scroll)
      const r = (el as HTMLElement).getBoundingClientRect()
      if (r.height < 1) continue
      if (r.top <= y && r.bottom > y) {
        if (r.top > crossingTop) {
          crossing = el
          crossingTop = r.top
        }
      } else if (r.top > y && !firstBelow) {
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

  private scheduleRelocate() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.emitRelocate(), SAVE_DEBOUNCE)
  }

  private emitRelocate() {
    const cfi = this.currentCfi()
    let percentage = this.sections.length
      ? this.anchorIndex / this.sections.length
      : 0
    try {
      if (cfi && this.book.locations?.length()) {
        const pct = this.book.locations.percentageFromCfi(cfi)
        if (typeof pct === 'number' && pct >= 0) percentage = pct
      }
    } catch {
      /* ignore */
    }
    this.cb.onRelocate?.({ cfi, percentage, chapter: this.chapterTitleFor(this.anchorIndex) })
  }

  private chapterTitleFor(i: number): string | undefined {
    const base = (this.sections[i]?.href ?? '').split('#')[0].split('/').pop() ?? ''
    for (const t of this.toc) {
      const th = (t.href ?? '').split('#')[0].split('/').pop() ?? ''
      if (th && th === base) return t.label
    }
    return undefined
  }

  // ---- navigation ----
  async goTo(target: string): Promise<void> {
    let sec: any
    try {
      sec = this.book.spine.get(target)
    } catch {
      sec = null
    }
    if (!sec) return
    const i = this.sections.findIndex((s) => s.index === sec.index)
    if (i < 0) return
    // brief cross-fade so the jump feels intentional, not a hard cut
    const sc = this.scroller
    sc.style.transition = 'none'
    sc.style.opacity = '0'
    // tear down the current window, mount the target fresh
    for (const idx of Array.from(this.mounted.keys())) this.removeSection(idx, false)
    this.mounted.clear()
    this.firstLoaded = i
    this.lastLoaded = i - 1
    this.appendBottom(i)
    const m = this.mounted.get(i)!
    try {
      await m.loaded
    } catch {
      /* ignore */
    }
    let intra = 0
    if (m.doc) {
      if (target.startsWith('epubcfi(')) {
        try {
          const range = new EpubCFI(target).toRange(m.doc)
          if (range) intra = Math.round(Math.max(0, range.getBoundingClientRect().top))
        } catch {
          /* ignore */
        }
      } else if (target.includes('#')) {
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
        if (el) intra = Math.round(Math.max(0, (el as HTMLElement).getBoundingClientRect().top))
      }
    }
    this.correcting = true
    this.scroller.scrollTop = intra
    this.correcting = false
    this.anchorIndex = i
    this.fillWindow()
    // fade the freshly-positioned content back in
    requestAnimationFrame(() => {
      sc.style.transition = 'opacity 0.3s ease'
      sc.style.opacity = '1'
    })
    this.emitRelocate()
  }

  // ---- settings ----
  async applySettings(settings: Settings) {
    const old = this.settings
    this.settings = settings
    if (old.theme !== settings.theme) {
      const bg = THEMES[settings.theme].bg
      this.scroller.style.background = bg
      for (const [, m] of this.mounted) m.el.style.background = bg
    }
    const layoutChanged =
      old.fontScale !== settings.fontScale ||
      old.lineHeight !== settings.lineHeight ||
      old.letterSpacing !== settings.letterSpacing ||
      old.margin !== settings.margin ||
      old.fontFamily !== settings.fontFamily ||
      old.bold !== settings.bold
    for (const [i, m] of this.mounted) {
      if (m.doc) this.injectCss(m.doc)
      if (layoutChanged) this.measure(i)
    }
    if (layoutChanged) {
      const key = `${this.bookId}:${this.layoutKey()}`
      const cached = await getHeights(key)
      const N = this.sections.length
      this.fromCache = !!(cached && cached.length === N)
      this.cacheComplete = this.fromCache && (await getHeightsComplete(key))
      // re-seed unmounted chapters for the NEW layout so they don't mount at a
      // stale height from the old font/size (which would drift on arrival)
      for (let i = 0; i < N; i++) {
        if (this.mounted.has(i)) continue
        this.heights[i] = this.fromCache ? cached![i] : this.estH
      }
      if (!this.cacheComplete && !this.premeasuring) {
        const ric = (window as any).requestIdleCallback
        if (typeof ric === 'function') ric(() => this.premeasureAll(), { timeout: 2500 })
        else window.setTimeout(() => this.premeasureAll(), 600)
      }
    }
  }

  // ---- highlights ----
  setHighlights(hs: Highlight[]) {
    this.highlights = hs
    for (const [i] of this.mounted) this.drawHighlights(i)
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
    // Only pop the editor AFTER the selection gesture ends and settles — never
    // mid-drag. While the user is still dragging (or adjusting the iOS handles),
    // `selectionchange` keeps firing and cancels any pending pop; when they lift
    // (mouseup/touchend) we wait a beat, then open. This stops the "it pops up
    // before I've finished selecting" problem.
    let settle: number | undefined
    const SETTLE = 420
    const arm = () => {
      window.clearTimeout(settle)
      const sel = doc.getSelection()
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return
      settle = window.setTimeout(() => this.handleSelection(i, doc), SETTLE)
    }
    doc.addEventListener('selectionchange', () => window.clearTimeout(settle))
    doc.addEventListener('mouseup', arm)
    doc.addEventListener('touchend', arm)
    doc.addEventListener('pointerup', arm)
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
    } catch (e) {
      console.error('[vr] cfiFromRange threw', i, (e as Error)?.message)
      return
    }
    const anchor = rangeToAnchor(doc, range)
    if (!anchor) {
      console.error('[vr] no anchor for selection', i)
      return
    }
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
    const m = this.mounted.get(i)
    if (m) {
      for (let k = m.drawn.length - 1; k >= 0; k--) {
        const d = m.drawn[k]
        for (const r of d.rects) {
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            const h = this.highlights.find((x) => x.id === d.id)
            if (h) {
              const anchor = this.anchorForCfi(h.cfi) ?? {
                centerX: e.clientX, top: e.clientY, bottom: e.clientY,
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

  private drawHighlights(i: number) {
    const m = this.mounted.get(i)
    if (!m || !m.doc) return
    const NS = 'http://www.w3.org/2000/svg'
    while (m.svg.firstChild) m.svg.removeChild(m.svg.firstChild)
    m.drawn = []
    for (const h of this.highlights) {
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
        // rects are in the iframe's own (content) coordinates; the svg overlays
        // the iframe in the same box, so use them directly.
        const rect = document.createElementNS(NS, 'rect')
        rect.setAttribute('x', String(r.left))
        rect.setAttribute('y', String(r.top))
        rect.setAttribute('width', String(r.width))
        rect.setAttribute('height', String(r.height))
        g.appendChild(rect)
      }
      m.svg.appendChild(g)
      m.drawn.push({ id: h.id, rects })
    }
  }

  private cfiInSection(cfi: string, i: number): boolean {
    try {
      const base = this.sections[i].cfiBase as string
      const a = cfi.match(/^epubcfi\((\/\d+\/\d+)/)?.[1]
      const b = base.match(/^(\/\d+\/\d+)/)?.[1]
      return !!a && !!b && a === b
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

  // ---- background pre-measure (build height cache for the whole book) ----
  private premeasuring = false
  private cacheTimer: number | null = null
  private scheduleCache() {
    if (this.cacheTimer) clearTimeout(this.cacheTimer)
    this.cacheTimer = window.setTimeout(() => {
      saveHeights(`${this.bookId}:${this.layoutKey()}`, this.heights.slice()).catch(() => {})
    }, 1500)
  }

  private async premeasureAll() {
    if (this.premeasuring || this.destroyed) return
    this.premeasuring = true
    const hidden = document.createElement('iframe')
    Object.assign(hidden.style, {
      position: 'absolute', left: '-99999px', top: '0',
      width: `${this.scroller.clientWidth}px`, height: '10px', border: '0',
      visibility: 'hidden',
    } as any)
    this.container.appendChild(hidden)
    // Measure in READING ORDER from the current position outward: the chapters
    // you're about to scroll into get accurate heights first, so they mount at
    // the right size (no over-estimated tail to drift through), then we backfill
    // the earlier ones for a complete cache.
    const start = this.firstLoaded
    const N = this.sections.length
    const order: number[] = []
    for (let i = start; i < N; i++) order.push(i)
    for (let i = 0; i < start; i++) order.push(i)
    for (const i of order) {
      if (this.destroyed) break
      if (this.mounted.has(i)) continue
      let h = 0
      try {
        const html = await this.sections[i].render(this.book.load.bind(this.book))
        h = await this.measureHidden(hidden, html)
      } catch {
        h = 0
      }
      if (h > 40) this.heights[i] = h
      await new Promise((r) => setTimeout(r, 0))
    }
    hidden.remove()
    this.premeasuring = false
    // only mark COMPLETE if we actually measured the whole book (not aborted)
    const finished = !this.destroyed
    if (finished) {
      this.cacheComplete = true
      saveHeights(`${this.bookId}:${this.layoutKey()}`, this.heights.slice(), true).catch(() => {})
    }
  }

  private measureHidden(iframe: HTMLIFrameElement, html: string): Promise<number> {
    return new Promise((resolve) => {
      iframe.addEventListener(
        'load',
        () => {
          try {
            const doc = iframe.contentDocument
            if (!doc) return resolve(0)
            this.injectCss(doc)
            const read = () =>
              Math.ceil(
                Math.max(doc.body?.scrollHeight ?? 0, doc.body?.getBoundingClientRect().height ?? 0, 0),
              )
            const imgs = Array.from(doc.querySelectorAll('img')).filter(
              (im) => !(im as HTMLImageElement).complete,
            )
            const done = () => requestAnimationFrame(() => resolve(read()))
            if (!imgs.length) return done()
            let left = imgs.length
            const tick = () => {
              if (--left <= 0) done()
            }
            for (const im of imgs) {
              im.addEventListener('load', tick, { once: true })
              im.addEventListener('error', tick, { once: true })
            }
            window.setTimeout(done, 1200)
          } catch {
            resolve(0)
          }
        },
        { once: true },
      )
      iframe.srcdoc = html
    })
  }
}
