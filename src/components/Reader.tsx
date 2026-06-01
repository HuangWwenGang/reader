import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getBook,
  getHighlights,
  saveHighlight,
  deleteHighlight,
  updateBookLocation,
} from '../lib/db'
import {
  getCFIComparator,
  openBookFromBuffer,
  renderOptions,
  themeRules,
  tuneContinuous,
  type Book,
} from '../lib/epub'
import { rangeToAnchor, type AnchorRect } from '../lib/geometry'
import { colorForTag } from '../lib/tags'
import {
  applyTheme,
  loadSettings,
  saveSettings,
  type Settings,
} from '../lib/settings'
import type { Highlight } from '../lib/types'
import HighlightEditor, { type EditorTarget } from './HighlightEditor'
import TocPanel, { type TocItem } from './TocPanel'
import NotesPanel from './NotesPanel'
import SettingsSheet from './SettingsSheet'

interface FloatBtn {
  anchor: AnchorRect
  cfi: string
  text: string
  selDoc: Document
}

export default function Reader({
  bookId,
  onClose,
}: {
  bookId: string
  onClose: () => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<any>(null)
  const highlightsRef = useRef<Highlight[]>([])
  const saveTimerRef = useRef<number | null>(null)
  const lastCfiRef = useRef<string | undefined>(undefined)
  const lastProgRef = useRef<string>('')
  // timestamp the editor opened, to ignore the ghost-click that opened it
  const editorOpenedRef = useRef(0)

  const openEditor = useCallback((t: EditorTarget) => {
    editorOpenedRef.current = Date.now()
    setFloatBtn(null)
    setEditor(t)
  }, [])

  // flush the pending reading position immediately (e.g. on exit) so re-opening
  // lands exactly where we left off instead of drifting
  // Line-level position: epub.js's currentLocation() snaps to the *start of the
  // topmost element* (paragraph-level). To restore to the exact line like native
  // readers, we find the character at the very top of the visible reading area
  // via caretRangeFromPoint and take its CFI.
  const getPreciseCfi = useCallback((): string | undefined => {
    const r = renditionRef.current
    const stage = stageRef.current
    if (!r || !stage) return undefined
    let list: any[] = []
    try {
      const c = r.getContents()
      list = Array.isArray(c) ? c : c ? [c] : []
    } catch {
      return undefined
    }
    const st = stage.getBoundingClientRect()
    const probeY = st.top + 4 // just inside the top edge of the reading area
    for (const contents of list) {
      const doc: Document | undefined = contents?.document
      const frameEl = doc?.defaultView?.frameElement as HTMLElement | null
      if (!doc || !frameEl) continue
      const fr = frameEl.getBoundingClientRect()
      if (fr.top - 1 <= probeY && fr.bottom >= probeY) {
        const localX = Math.max(2, st.left + st.width / 2 - fr.left)
        const localY = probeY - fr.top
        try {
          const range = (doc as any).caretRangeFromPoint?.(localX, localY)
          if (range) {
            const cfi = contents.cfiFromRange(range)
            if (cfi) return cfi
          }
        } catch {
          /* ignore */
        }
      }
    }
    return undefined
  }, [])

  const flushLocation = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    // prefer line-precise position, then live currentLocation, then last cfi
    let cfi = getPreciseCfi() ?? lastCfiRef.current
    if (!cfi) {
      try {
        const loc = renditionRef.current?.currentLocation?.()
        if (loc?.start?.cfi) cfi = loc.start.cfi
      } catch {
        /* ignore */
      }
    }
    if (cfi) {
      lastCfiRef.current = cfi
      updateBookLocation(bookId, cfi).catch(() => {})
    }
  }, [bookId, getPreciseCfi])

  const [title, setTitle] = useState('')
  const [toc, setToc] = useState<TocItem[]>([])
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [panel, setPanel] = useState<'toc' | 'notes' | null>(null)
  const [floatBtn, setFloatBtn] = useState<FloatBtn | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [showSettings, setShowSettings] = useState(false)
  const [barVisible, setBarVisible] = useState(true) // immersive: tap toggles chrome
  const settingsRef = useRef(settings)
  const prevFlowRef = useRef(settings.flow)
  const popupOpenRef = useRef(false)
  const pendingCfiRef = useRef<string | null>(null) // gray "pending selection" highlight

  useEffect(() => {
    highlightsRef.current = highlights
  }, [highlights])
  useEffect(() => {
    popupOpenRef.current = floatBtn != null || editor != null
  }, [floatBtn, editor])

  // remove the temporary gray "pending selection" highlight
  const clearPending = useCallback(() => {
    const cfi = pendingCfiRef.current
    if (cfi) {
      try {
        renditionRef.current?.annotations.remove(cfi, 'highlight')
      } catch {
        /* ignore */
      }
      pendingCfiRef.current = null
    }
  }, [])

  // ---- annotation helpers (epub.js) ----
  const drawHighlight = useCallback((h: Highlight) => {
    const r = renditionRef.current
    if (!r) return
    try {
      r.annotations.add(
        'highlight',
        h.cfi,
        {},
        () => openEditorForHighlight(h.id),
        'hl',
        {
          fill: colorForTag(h.tag),
          'fill-opacity': '0.3',
          'mix-blend-mode': 'multiply',
        },
      )
    } catch (e) {
      console.warn('annotation add failed', e)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const removeHighlightDraw = useCallback((cfi: string) => {
    try {
      renditionRef.current?.annotations.remove(cfi, 'highlight')
    } catch {
      /* ignore */
    }
  }, [])

  const openEditorForHighlight = useCallback((id: string) => {
    const h = highlightsRef.current.find((x) => x.id === id)
    if (!h) return
    let anchor: AnchorRect | null = null
    try {
      const range = renditionRef.current?.getRange(h.cfi)
      const doc = range?.startContainer?.ownerDocument as Document | undefined
      if (doc && range) anchor = rangeToAnchor(doc, range)
    } catch {
      anchor = null
    }
    if (!anchor) {
      anchor = {
        centerX: window.innerWidth / 2,
        top: window.innerHeight / 2,
        bottom: window.innerHeight / 2,
      }
    }
    openEditor({
      highlightId: h.id,
      text: h.text,
      note: h.note ?? '',
      tag: h.tag,
      anchor,
      autoFocus: false, // editing existing: just show popup, no keyboard
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- mount / remount the rendition ----
  const mountRendition = useCallback(async (startCfi?: string) => {
    const book = bookRef.current
    const stage = stageRef.current
    if (!book || !stage) return
    if (renditionRef.current) {
      try {
        renditionRef.current.destroy()
      } catch {
        /* ignore */
      }
      renditionRef.current = null
    }
    stage.innerHTML = ''

    const rendition = book.renderTo(stage, renderOptions(settingsRef.current))
    renditionRef.current = rendition
    ;(window as any).rendition = rendition // for debugging position restore
    rendition.themes.default(themeRules(settingsRef.current) as any)
    rendition.themes.fontSize(`${settingsRef.current.fontScale}%`)

    rendition.on('relocated', (location: any) => {
      // save the line-precise cfi when we can, else the element-level one
      const cfi = getPreciseCfi() ?? location?.start?.cfi
      if (cfi) {
        lastCfiRef.current = cfi
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        const toSave = cfi
        saveTimerRef.current = window.setTimeout(() => {
          updateBookLocation(bookId, toSave).catch(console.error)
        }, 250)
      }
      const pct = location?.start?.percentage
      if (typeof pct === 'number') {
        const label = `${Math.round(pct * 100)}%`
        if (label !== lastProgRef.current) {
          lastProgRef.current = label
          setProgress(label)
        }
      }
      clearPending()
      setFloatBtn((b) => (b ? null : b))
    })

    rendition.on('selected', (cfiRange: string, contents: any) => {
      let range: Range | null = null
      try {
        range = contents.range(cfiRange)
      } catch {
        range = null
      }
      const text = (range?.toString() ?? '').trim()
      if (!range || !text) return
      const anchor = rangeToAnchor(contents.document, range)
      if (!anchor) return
      // Draw our OWN gray highlight for the selection, then collapse the native
      // selection — this makes iOS's Copy/Look-Up callout disappear so it can't
      // cover our button. Our button + gray mark replace the system menu.
      clearPending()
      try {
        rendition.annotations.add('highlight', cfiRange, {}, undefined, 'pending', {
          fill: '#9a9a9a',
          'fill-opacity': '0.35',
        })
        pendingCfiRef.current = cfiRange
      } catch {
        /* ignore */
      }
      try {
        contents.window.getSelection()?.removeAllRanges()
      } catch {
        /* ignore */
      }
      setFloatBtn({ anchor, cfi: cfiRange, text, selDoc: contents.document })
    })

    // single tap in the reading area: dismiss a popup, else toggle the chrome
    // (immersive). iOS reserves double-tap for word selection, so we use a tap.
    rendition.on('rendered', (_section: any, view: any) => {
      const doc: Document | undefined =
        view?.document ?? view?.contents?.document
      if (!doc || (doc as any).__tapBound) return
      ;(doc as any).__tapBound = true
      doc.addEventListener('click', (ev: MouseEvent) => {
        const sel = doc.getSelection()
        if (sel && !sel.isCollapsed) return
        if ((ev.target as HTMLElement)?.closest?.('a[href]')) return
        if (popupOpenRef.current) {
          clearPending()
          setFloatBtn(null)
          setEditor(null)
          return
        }
        setBarVisible((v) => !v)
      })
    })

    await rendition.display(startCfi || undefined)
    // keep recently-read sections alive in scroll mode (smoother fast-scroll)
    if (settingsRef.current.flow === 'scrolled') tuneContinuous(rendition)
    for (const h of highlightsRef.current) drawHighlight(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, drawHighlight])

  // ---- initial open ----
  useEffect(() => {
    let cancelled = false
    async function setup() {
      const rec = await getBook(bookId)
      if (!rec) {
        setError('找不到这本书')
        return
      }
      if (cancelled) return
      setTitle(rec.title)
      // ArrayBuffer is the current format; fall back to legacy Blob records.
      let buf: ArrayBuffer | null = rec.file ?? null
      const legacy = (rec as any).fileBlob as Blob | undefined
      if (!buf && legacy?.arrayBuffer) {
        try {
          buf = await legacy.arrayBuffer()
        } catch {
          buf = null
        }
      }
      if (!buf) {
        setError('这本书的数据已失效（旧格式），请删除后重新导入。')
        return
      }
      const book = openBookFromBuffer(buf)
      bookRef.current = book
      await book.ready
      if (cancelled) return
      book.loaded.navigation
        .then((nav: any) => {
          if (!cancelled) setToc((nav?.toc ?? []) as TocItem[])
        })
        .catch(() => {})

      const hs = await getHighlights(bookId)
      highlightsRef.current = hs
      setHighlights(hs)

      lastCfiRef.current = rec.lastLocation
      await mountRendition(rec.lastLocation)
    }
    setup().catch((e) => {
      console.error(e)
      setError(String(e?.message ?? e))
    })
    return () => {
      cancelled = true
      flushLocation() // save exact position before tearing down (avoids drift)
      try {
        renditionRef.current?.destroy()
      } catch {
        /* ignore */
      }
      try {
        bookRef.current?.destroy()
      } catch {
        /* ignore */
      }
      renditionRef.current = null
      bookRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  // ---- live settings: theme/font update, or remount on flow change ----
  useEffect(() => {
    settingsRef.current = settings
    saveSettings(settings)
    applyTheme(settings.theme)
    const r = renditionRef.current
    if (!r) return
    if (prevFlowRef.current !== settings.flow) {
      prevFlowRef.current = settings.flow
      mountRendition(lastCfiRef.current).catch(console.error)
    } else {
      try {
        r.themes.default(themeRules(settings) as any)
        r.themes.fontSize(`${settings.fontScale}%`)
      } catch (e) {
        console.warn(e)
      }
    }
  }, [settings, mountRendition])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }))
  }, [])

  // persist reading position when the app is backgrounded/closed (iOS PWA)
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushLocation()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flushLocation)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flushLocation)
    }
  }, [flushLocation])

  // ---- create a highlight from the floating button ----
  async function startHighlight(fb: FloatBtn) {
    const now = Date.now()
    const h: Highlight = {
      id: crypto.randomUUID(),
      bookId,
      cfi: fb.cfi,
      text: fb.text,
      note: '',
      tag: undefined,
      createdAt: now,
      updatedAt: now,
    }
    highlightsRef.current = [...highlightsRef.current, h]
    setHighlights(highlightsRef.current)
    await saveHighlight(h)
    // replace the gray pending mark with the real colored highlight (same cfi)
    pendingCfiRef.current = null
    try {
      renditionRef.current?.annotations.remove(fb.cfi, 'highlight')
    } catch {
      /* ignore */
    }
    drawHighlight(h)
    try {
      fb.selDoc.getSelection()?.removeAllRanges()
    } catch {
      /* ignore */
    }
    openEditor({
      highlightId: h.id,
      text: h.text,
      note: '',
      tag: undefined,
      anchor: fb.anchor,
      autoFocus: true, // brand-new highlight: focus so the user types immediately
    })
  }

  async function handleEditorSave(note: string, tag: string | undefined) {
    if (!editor) return
    const list = highlightsRef.current
    const idx = list.findIndex((x) => x.id === editor.highlightId)
    if (idx === -1) {
      setEditor(null)
      return
    }
    const updated: Highlight = { ...list[idx], note, tag, updatedAt: Date.now() }
    const next = [...list]
    next[idx] = updated
    highlightsRef.current = next
    setHighlights(next)
    await saveHighlight(updated)
    // re-draw so the color matches the (possibly changed) tag
    removeHighlightDraw(updated.cfi)
    drawHighlight(updated)
    setEditor(null)
  }

  async function handleEditorDelete() {
    if (!editor) return
    const list = highlightsRef.current
    const h = list.find((x) => x.id === editor.highlightId)
    if (h) {
      removeHighlightDraw(h.cfi)
      await deleteHighlight(h.id)
      const next = list.filter((x) => x.id !== h.id)
      highlightsRef.current = next
      setHighlights(next)
    }
    setEditor(null)
  }

  // ---- notes list sorted by position ----
  const [sortedNotes, setSortedNotes] = useState<Highlight[]>([])
  useEffect(() => {
    const cmp = getCFIComparator()
    setSortedNotes([...highlights].sort((a, b) => cmp(a.cfi, b.cfi)))
  }, [highlights])

  // Did we actually land on the target section? (continuous display() is flaky)
  function landedNear(loc: any, target: string): boolean {
    if (!loc?.start) return false
    if (target.startsWith('epubcfi(')) {
      const seg = (s: string) => s?.match(/^epubcfi\((\/\d+\/\d+)/)?.[1] ?? ''
      const a = seg(loc.start.cfi)
      return !!a && a === seg(target)
    }
    const want = target.split('#')[0].split('/').pop() ?? ''
    const cur = (loc.start.href ?? '').split('/').pop() ?? ''
    return !!want && !!cur && (cur === want || cur.endsWith(want) || want.endsWith(cur))
  }

  // Jump and KEEP RETRYING until we've actually landed on the target — so the
  // user taps once instead of mashing the entry several times to "refresh".
  const jumpingRef = useRef(false)
  async function robustDisplay(target: string) {
    const r = renditionRef.current
    if (!r || jumpingRef.current) return
    jumpingRef.current = true
    try {
      for (let i = 0; i < 6; i++) {
        try {
          await r.display(target)
        } catch {
          /* ignore */
        }
        await new Promise((res) => setTimeout(res, 160 + i * 120))
        try {
          if (landedNear(r.currentLocation?.(), target)) break
        } catch {
          /* ignore */
        }
      }
    } finally {
      jumpingRef.current = false
    }
  }

  function jumpToNote(h: Highlight) {
    setPanel(null)
    setFloatBtn(null)
    setEditor(null)
    robustDisplay(h.cfi)
  }

  function navigateToc(href: string) {
    setPanel(null)
    robustDisplay(href)
  }

  if (error) {
    return (
      <div className="reader">
        <div className="reader-bar">
          <button className="icon-btn" onClick={onClose}>
            ‹
          </button>
          <div className="spacer" />
        </div>
        <div className="empty">{error}</div>
      </div>
    )
  }

  return (
    <div className={'reader' + (barVisible ? '' : ' immersive')}>
      <div className="reader-bar">
        <button className="icon-btn" onClick={onClose} title="返回书架">
          ‹
        </button>
        <button className="icon-btn" onClick={() => setPanel('toc')} title="目录">
          ☰
        </button>
        <div className="title">{title}</div>
        <div className="spacer" />
        <button
          className="icon-btn"
          onClick={() => setShowSettings(true)}
          title="显示设置"
        >
          Aa
        </button>
        <button className="icon-btn" onClick={() => setPanel('notes')} title="笔记">
          ✦
        </button>
      </div>

      <div className="reader-stage" ref={stageRef} />

      <div className="reader-progress">{progress}</div>

      {floatBtn && (
        <button
          className="float-btn"
          style={{
            left: Math.min(
              Math.max(floatBtn.anchor.centerX, 80),
              window.innerWidth - 80,
            ),
            top: Math.max(floatBtn.anchor.top - 8, 64),
          }}
          onClick={(e) => {
            e.stopPropagation()
            startHighlight(floatBtn)
          }}
        >
          ✍️ 划线并写想法
        </button>
      )}

      {editor && (
        <>
          <div
            className="editor-backdrop"
            onClick={() => {
              // ignore the same tap that opened the editor (iOS ghost click)
              if (Date.now() - editorOpenedRef.current < 400) return
              setEditor(null)
            }}
          />
          <HighlightEditor
            target={editor}
            onSave={handleEditorSave}
            onCancel={() => setEditor(null)}
            onDelete={handleEditorDelete}
          />
        </>
      )}

      {panel === 'toc' && (
        <TocPanel toc={toc} onNavigate={navigateToc} onClose={() => setPanel(null)} />
      )}
      {panel === 'notes' && (
        <NotesPanel
          highlights={sortedNotes}
          onJump={jumpToNote}
          onClose={() => setPanel(null)}
        />
      )}

      {showSettings && (
        <SettingsSheet
          settings={settings}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
