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
  getOverlayer,
  getReaderCSS,
  loadFoliate,
} from '../lib/foliate'
import { rangeToAnchor, type AnchorRect } from '../lib/geometry'
import { colorForTag } from '../lib/tags'
import type { Book, Highlight } from '../lib/types'
import HighlightEditor, { type EditorTarget } from './HighlightEditor'
import TocPanel, { type TocItem } from './TocPanel'
import NotesPanel from './NotesPanel'

interface FloatBtn {
  anchor: AnchorRect
  cfi: string
  text: string
}

export default function Reader({
  bookId,
  onClose,
}: {
  bookId: string
  onClose: () => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<any>(null)
  const overlayerRef = useRef<any>(null)
  const highlightsRef = useRef<Highlight[]>([])
  const popupOpenRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  // set true (synchronously) when a click lands on an existing highlight, so the
  // deferred page-turn for that same click is cancelled (avoids edge-tap conflict)
  const annotationHitRef = useRef(false)

  const [book, setBook] = useState<Book | null>(null)
  const [toc, setToc] = useState<TocItem[]>([])
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [panel, setPanel] = useState<'toc' | 'notes' | null>(null)
  const [floatBtn, setFloatBtn] = useState<FloatBtn | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)

  // keep ref mirror for use inside iframe/foliate event callbacks (stale closures)
  useEffect(() => {
    highlightsRef.current = highlights
  }, [highlights])
  useEffect(() => {
    popupOpenRef.current = floatBtn != null || editor != null
  }, [floatBtn, editor])

  const closePopups = useCallback(() => {
    setFloatBtn(null)
    setEditor(null)
    try {
      viewRef.current?.deselect()
    } catch {
      /* ignore */
    }
  }, [])

  // ---- main setup: open the book ----
  useEffect(() => {
    let cancelled = false
    let view: any = null

    async function setup() {
      const rec = await getBook(bookId)
      if (!rec) {
        setError('找不到这本书')
        return
      }
      if (cancelled) return
      setBook(rec)

      await loadFoliate()
      overlayerRef.current = await getOverlayer()
      if (cancelled) return

      view = document.createElement('foliate-view')
      viewRef.current = view
      stageRef.current!.appendChild(view)
      await view.open(rec.fileBlob)
      if (cancelled) return

      view.addEventListener('relocate', onRelocate)
      view.addEventListener('load', onLoad)
      view.addEventListener('draw-annotation', onDrawAnnotation)
      view.addEventListener('create-overlay', onCreateOverlay)
      view.addEventListener('show-annotation', onShowAnnotation)

      view.renderer.setStyles?.(getReaderCSS())
      setToc(view.book?.toc ?? [])

      const hs = await getHighlights(bookId)
      highlightsRef.current = hs
      setHighlights(hs)

      await view.init({
        lastLocation: rec.lastLocation,
        showTextStart: !rec.lastLocation,
      })

      // draw highlights that fall in the currently rendered section
      for (const h of hs) view.addAnnotation({ value: h.cfi })
    }

    // ---- foliate event handlers (closure over `view`) ----
    function onRelocate(e: any) {
      const { cfi, fraction } = e.detail
      if (typeof fraction === 'number') {
        setProgress(`${Math.round(fraction * 100)}%`)
      }
      if (cfi) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = window.setTimeout(() => {
          updateBookLocation(bookId, cfi).catch(console.error)
        }, 400)
      }
      setFloatBtn(null)
    }

    function onLoad(e: any) {
      const { doc, index } = e.detail
      doc.addEventListener('pointerup', () => handleSelection(doc, index))
      doc.addEventListener('click', (ev: MouseEvent) => handlePageClick(doc, ev))
    }

    function handleSelection(doc: Document, index: number) {
      const sel = doc.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setFloatBtn(null)
        return
      }
      const range = sel.getRangeAt(0)
      const text = sel.toString().trim()
      if (!text) {
        setFloatBtn(null)
        return
      }
      const cfi = view.getCFI(index, range)
      const anchor = rangeToAnchor(doc, range)
      if (!anchor) return
      setFloatBtn({ anchor, cfi, text })
    }

    function handlePageClick(doc: Document, ev: MouseEvent) {
      const sel = doc.getSelection()
      if (sel && !sel.isCollapsed) return // user is selecting; don't turn page
      if (popupOpenRef.current) {
        closePopups()
        return
      }
      const target = ev.target as HTMLElement
      if (target?.closest?.('a[href]')) return // let foliate handle links
      const w = doc.defaultView?.innerWidth ?? window.innerWidth
      const x = ev.clientX
      if (x >= w * 0.3 && x <= w * 0.7) return // middle band: do nothing
      const dir = x < w * 0.3 ? 'prev' : 'next'
      // Defer one tick: if this same click also hit a highlight (foliate fires
      // 'show-annotation' synchronously), cancel the turn and let the editor open.
      annotationHitRef.current = false
      window.setTimeout(() => {
        if (annotationHitRef.current) return
        if (dir === 'prev') view.prev()
        else view.next()
      }, 0)
    }

    function onDrawAnnotation(e: any) {
      const { draw, annotation } = e.detail
      const h = highlightsRef.current.find((x) => x.cfi === annotation.value)
      draw(overlayerRef.current.highlight, { color: colorForTag(h?.tag) })
    }

    function onCreateOverlay() {
      // a new section's overlay was created — (re)draw all known highlights
      for (const h of highlightsRef.current) view.addAnnotation({ value: h.cfi })
    }

    function onShowAnnotation(e: any) {
      annotationHitRef.current = true // cancel any pending page-turn for this click
      const { value, range } = e.detail
      const h = highlightsRef.current.find((x) => x.cfi === value)
      if (!h) return
      const doc = range?.startContainer?.ownerDocument as Document | undefined
      const anchor = doc ? rangeToAnchor(doc, range) : null
      if (!anchor) return
      setFloatBtn(null)
      setEditor({
        highlightId: h.id,
        text: h.text,
        note: h.note ?? '',
        tag: h.tag,
        anchor,
      })
    }

    setup().catch((e) => {
      console.error(e)
      setError(String(e?.message ?? e))
    })

    return () => {
      cancelled = true
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (view) {
        try {
          view.close?.()
        } catch {
          /* ignore */
        }
        view.remove()
      }
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  // ---- create a highlight from the floating button ----
  async function startHighlight(fb: FloatBtn) {
    const view = viewRef.current
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
    try {
      await view.addAnnotation({ value: h.cfi })
    } catch (e) {
      console.error(e)
    }
    view.deselect?.()
    setFloatBtn(null)
    // immediately open the editor, focused, anchored at the selection
    setEditor({
      highlightId: h.id,
      text: h.text,
      note: '',
      tag: undefined,
      anchor: fb.anchor,
    })
  }

  // ---- editor actions ----
  async function handleEditorSave(note: string, tag: string | undefined) {
    if (!editor) return
    const view = viewRef.current
    const list = highlightsRef.current
    const idx = list.findIndex((x) => x.id === editor.highlightId)
    if (idx === -1) {
      setEditor(null)
      return
    }
    const updated: Highlight = {
      ...list[idx],
      note,
      tag,
      updatedAt: Date.now(),
    }
    const next = [...list]
    next[idx] = updated
    highlightsRef.current = next
    setHighlights(next)
    await saveHighlight(updated)
    // re-draw so the highlight color matches the (possibly changed) tag
    try {
      await view.deleteAnnotation({ value: updated.cfi })
      await view.addAnnotation({ value: updated.cfi })
    } catch (e) {
      console.error(e)
    }
    setEditor(null)
  }

  async function handleEditorDelete() {
    if (!editor) return
    const view = viewRef.current
    const list = highlightsRef.current
    const h = list.find((x) => x.id === editor.highlightId)
    if (h) {
      try {
        await view.deleteAnnotation({ value: h.cfi })
      } catch (e) {
        console.error(e)
      }
      await deleteHighlight(h.id)
      const next = list.filter((x) => x.id !== h.id)
      highlightsRef.current = next
      setHighlights(next)
    }
    setEditor(null)
  }

  // ---- notes list, sorted by position in the book ----
  const [sortedNotes, setSortedNotes] = useState<Highlight[]>([])
  useEffect(() => {
    let alive = true
    getCFIComparator().then((cmp) => {
      if (!alive) return
      const arr = [...highlights].sort((a, b) => cmp(a.cfi, b.cfi))
      setSortedNotes(arr)
    })
    return () => {
      alive = false
    }
  }, [highlights])

  function jumpToNote(h: Highlight) {
    setPanel(null)
    closePopups()
    viewRef.current?.goTo(h.cfi).catch(console.error)
  }

  function navigateToc(href: string) {
    setPanel(null)
    viewRef.current?.goTo(href).catch(console.error)
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
    <div className="reader">
      <div className="reader-bar">
        <button className="icon-btn" onClick={onClose} title="返回书架">
          ‹
        </button>
        <button
          className="icon-btn"
          onClick={() => setPanel('toc')}
          title="目录"
        >
          ☰
        </button>
        <div className="title">{book?.title ?? ''}</div>
        <div className="spacer" />
        <button
          className="icon-btn"
          onClick={() => setPanel('notes')}
          title="笔记"
        >
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
        <HighlightEditor
          target={editor}
          onSave={handleEditorSave}
          onCancel={() => setEditor(null)}
          onDelete={handleEditorDelete}
        />
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
    </div>
  )
}
