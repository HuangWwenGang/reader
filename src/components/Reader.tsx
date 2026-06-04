import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getBook,
  getHighlights,
  saveHighlight,
  deleteHighlight,
  updateBookLocation,
  saveBookLocations,
} from '../lib/db'
import { getCFIComparator, openBookFromBuffer } from '../lib/epub'
import { VirtualReader } from '../lib/virtualReader'
import type { AnchorRect } from '../lib/geometry'
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
import ChatSheet from './ChatSheet'

export default function Reader({
  bookId,
  onClose,
}: {
  bookId: string
  onClose: () => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<VirtualReader | null>(null)
  const bookRef = useRef<any>(null)
  const highlightsRef = useRef<Highlight[]>([])
  const lastCfiRef = useRef<string | undefined>(undefined)
  const lastProgRef = useRef<string>('')
  const editorOpenedRef = useRef(0)
  const popupOpenRef = useRef(false)
  const resumeCfiRef = useRef<string | null>(null)

  const [title, setTitle] = useState('')
  const [toc, setToc] = useState<TocItem[]>([])
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [panel, setPanel] = useState<'toc' | 'notes' | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatQuote, setChatQuote] = useState<string | null>(null) // selection to attach
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [showSettings, setShowSettings] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [barVisible, setBarVisible] = useState(true)
  const settingsRef = useRef(settings)

  useEffect(() => {
    highlightsRef.current = highlights
  }, [highlights])
  useEffect(() => {
    popupOpenRef.current = editor != null
  }, [editor])

  const openEditor = useCallback((t: EditorTarget) => {
    editorOpenedRef.current = Date.now()
    setEditor(t)
  }, [])

  const openEditorForHighlight = useCallback((id: string, anchor: AnchorRect) => {
    const h = highlightsRef.current.find((x) => x.id === id)
    if (!h) return
    openEditor({
      highlightId: h.id,
      cfi: h.cfi,
      text: h.text,
      note: h.note ?? '',
      tag: h.tag,
      anchor,
      autoFocus: false,
    })
  }, [openEditor])

  const flushLocation = useCallback(() => {
    const cfi = engineRef.current?.currentCfi() ?? lastCfiRef.current
    if (cfi) {
      lastCfiRef.current = cfi
      updateBookLocation(bookId, cfi).catch(() => {})
    }
  }, [bookId])

  // ---- open the book ----
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

      const engine = new VirtualReader(book, stageRef.current!, settingsRef.current, {
        onRelocate: ({ cfi, percentage, chapter }) => {
          if (cfi) {
            lastCfiRef.current = cfi
            updateBookLocation(bookId, cfi).catch(() => {})
          }
          const label =
            (chapter ? `${chapter} · ` : '') + `${Math.round(percentage * 100)}%`
          if (label !== lastProgRef.current) {
            lastProgRef.current = label
            setProgress(label)
          }
        },
        onSelected: ({ cfiRange, text, anchor }) => {
          if (popupOpenRef.current) return
          openEditor({ cfi: cfiRange, text, note: '', tag: undefined, anchor })
        },
        onHighlightClick: (id, anchor) => openEditorForHighlight(id, anchor),
        onTap: () => setBarVisible((v) => !v),
      })
      engineRef.current = engine
      ;(window as any).vr = engine // debug
      await engine.start(bookId, rec.lastLocation, hs)

      // build the locations index for an accurate whole-book % (cached)
      if (rec.locations) {
        try {
          book.locations.load(rec.locations)
        } catch {
          /* ignore */
        }
      } else {
        const gen = () => {
          if (cancelled || !book.locations) return
          Promise.resolve(book.locations.generate(1600))
            .then(() => {
              if (!cancelled) {
                try {
                  saveBookLocations(bookId, book.locations.save())
                } catch {
                  /* ignore */
                }
              }
            })
            .catch(() => {})
        }
        const ric = (window as any).requestIdleCallback
        if (typeof ric === 'function') ric(gen, { timeout: 4000 })
        else window.setTimeout(gen, 2000)
      }
    }
    setup().catch((e) => {
      console.error(e)
      setError(String(e?.message ?? e))
    })
    return () => {
      cancelled = true
      flushLocation()
      try {
        engineRef.current?.destroy()
      } catch {
        /* ignore */
      }
      try {
        bookRef.current?.destroy()
      } catch {
        /* ignore */
      }
      engineRef.current = null
      bookRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  // ---- live settings ----
  useEffect(() => {
    settingsRef.current = settings
    saveSettings(settings)
    applyTheme(settings.theme)
    engineRef.current?.applySettings(settings)
  }, [settings])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }))
  }, [])

  // persist + restore position around backgrounding
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        resumeCfiRef.current = engineRef.current?.currentCfi() ?? lastCfiRef.current ?? null
        flushLocation()
      } else {
        const cfi = resumeCfiRef.current
        if (cfi) window.setTimeout(() => engineRef.current?.goTo(cfi), 250)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flushLocation)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', flushLocation)
    }
  }, [flushLocation])

  // ---- editor actions ----
  async function handleEditorSave(note: string, tag: string | undefined) {
    if (!editor) return
    const list = highlightsRef.current
    let next: Highlight[]
    if (editor.highlightId) {
      const idx = list.findIndex((x) => x.id === editor.highlightId)
      if (idx === -1) {
        setEditor(null)
        return
      }
      const updated: Highlight = { ...list[idx], note, tag, updatedAt: Date.now() }
      next = [...list]
      next[idx] = updated
      await saveHighlight(updated)
    } else {
      const now = Date.now()
      const h: Highlight = {
        id: crypto.randomUUID(),
        bookId,
        cfi: editor.cfi,
        text: editor.text,
        note,
        tag,
        createdAt: now,
        updatedAt: now,
      }
      next = [...list, h]
      await saveHighlight(h)
    }
    highlightsRef.current = next
    setHighlights(next)
    engineRef.current?.setHighlights(next)
    setEditor(null)
  }

  async function handleEditorDelete() {
    if (!editor?.highlightId) {
      setEditor(null)
      return
    }
    const next = highlightsRef.current.filter((x) => x.id !== editor.highlightId)
    await deleteHighlight(editor.highlightId)
    highlightsRef.current = next
    setHighlights(next)
    engineRef.current?.setHighlights(next)
    setEditor(null)
  }

  // ---- notes list sorted by position ----
  const [sortedNotes, setSortedNotes] = useState<Highlight[]>([])
  useEffect(() => {
    const cmp = getCFIComparator()
    setSortedNotes([...highlights].sort((a, b) => cmp(a.cfi, b.cfi)))
  }, [highlights])

  function jumpToNote(h: Highlight) {
    setPanel(null)
    setEditor(null)
    engineRef.current?.goTo(h.cfi)
  }

  function navigateToc(href: string) {
    setPanel(null)
    engineRef.current?.goTo(href)
  }

  if (error) {
    return (
      <div className="reader">
        <button className="float-ctrl back" onClick={onClose}>
          ‹
        </button>
        <div className="empty">{error}</div>
      </div>
    )
  }

  return (
    <div className={'reader' + (barVisible ? '' : ' immersive')}>
      <div className="reader-stage" ref={stageRef} />

      <button className="float-ctrl back" onClick={onClose} aria-label="返回书架">
        ‹
      </button>
      <button
        className="float-ctrl menu"
        onClick={() => setMenuOpen(true)}
        aria-label="菜单"
      >
        ☰
      </button>

      {menuOpen && (
        <>
          <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="reader-menu">
            <div className="reader-menu-title">{title}</div>
            <button
              className="menu-item"
              onClick={() => {
                setMenuOpen(false)
                setPanel('toc')
              }}
            >
              <span>目录</span>
              <span className="menu-val">{progress}</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setMenuOpen(false)
                setPanel('notes')
              }}
            >
              <span>划线 / 笔记</span>
              <span className="menu-val">{highlights.length}</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setMenuOpen(false)
                setShowSettings(true)
              }}
            >
              <span>主题与设置</span>
              <span className="menu-val">Aa</span>
            </button>
          </div>
        </>
      )}

      {editor && (
        <>
          <div
            className="editor-backdrop"
            onClick={() => {
              if (Date.now() - editorOpenedRef.current < 400) return
              setEditor(null)
            }}
          />
          <HighlightEditor
            target={editor}
            onSave={handleEditorSave}
            onCancel={() => setEditor(null)}
            onDelete={handleEditorDelete}
            onAsk={() => {
              const q = editor.text
              setEditor(null)
              setChatQuote(q)
              setChatOpen(true)
            }}
          />
        </>
      )}

      {chatOpen && (
        <ChatSheet
          bookId={bookId}
          quote={chatQuote}
          onQuoteConsumed={() => setChatQuote(null)}
          jumpTo={(cfi) => engineRef.current?.goTo(cfi)}
          onClose={() => {
            setChatOpen(false)
            setChatQuote(null)
            if (stageRef.current) stageRef.current.style.bottom = ''
          }}
          onHeight={(px) => {
            // push the reader up above the sheet so text is never covered
            if (stageRef.current) {
              stageRef.current.style.bottom = Math.min(px, window.innerHeight * 0.55) + 'px'
            }
          }}
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
