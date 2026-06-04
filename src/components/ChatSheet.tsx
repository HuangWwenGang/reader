import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getBookIndexMeta, getChat, saveChat, clearChat } from '../lib/db'
import { aiReady, loadAIConfig } from '../lib/ai/config'
import { makeProvider } from '../lib/ai/providers'
import { retrieve } from '../lib/ai/retrieve'
import type { ChatTurn, ChatMessage } from '../lib/ai/types'

type Snap = 'peek' | 'half' | 'full'
const SNAP_VH: Record<Snap, number> = { peek: 0.12, half: 0.52, full: 0.9 }
const HISTORY_TURNS = 6 // how many prior turns to send for continuity

function snapHeight(s: Snap) {
  return Math.round(window.innerHeight * SNAP_VH[s])
}

// Resizable bottom-sheet AI chat: a persistent per-book thread that coexists with
// the reader (the reader is pushed up above it, never covered). Multi-turn, each
// question re-retrieves from the whole book; answers cite sources you can jump to.
export default function ChatSheet({
  bookId,
  quote,
  onQuoteConsumed,
  jumpTo,
  onClose,
  onHeight,
}: {
  bookId: string
  quote: string | null
  onQuoteConsumed: () => void
  jumpTo: (cfi: string) => void
  onClose: () => void
  onHeight: (px: number) => void
}) {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [pendingQuote, setPendingQuote] = useState<string | null>(quote)
  const [busy, setBusy] = useState(false)
  const [snap, setSnap] = useState<Snap>('half')
  const [dragH, setDragH] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const turnsRef = useRef<ChatTurn[]>([])

  // load persisted thread
  useEffect(() => {
    let alive = true
    getChat(bookId).then((c) => {
      if (alive && c) {
        setTurns(c.turns)
        turnsRef.current = c.turns
      }
    })
    return () => {
      alive = false
      abortRef.current?.abort()
    }
  }, [bookId])

  // a new selection arrived from the reader → attach it
  useEffect(() => {
    if (quote) {
      setPendingQuote(quote)
      setSnap('half')
    }
  }, [quote])

  // report height up so the reader can shrink above the sheet (no occlusion)
  const height = dragH ?? snapHeight(snap)
  useEffect(() => {
    onHeight(height)
  }, [height, onHeight])

  // keep the thread scrolled to the newest message
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [turns])

  function persist(next: ChatTurn[]) {
    turnsRef.current = next
    setTurns(next)
    saveChat({ bookId, turns: next, updatedAt: Date.now() }).catch(() => {})
  }

  async function send() {
    const q = input.trim()
    if ((!q && !pendingQuote) || busy) return
    const cfg = loadAIConfig()
    const ready = aiReady(cfg)
    if (!ready.embed || !ready.chat) {
      appendSystemNote('请先在书架的「AI 设置」里填好接口和 Key。')
      return
    }
    const meta = await getBookIndexMeta(bookId)
    if (meta?.state !== 'ready') {
      appendSystemNote('这本书还没建立索引——请先回书架点这本书的「建立索引」。')
      return
    }

    const usedQuote = pendingQuote ?? undefined
    setInput('')
    setPendingQuote(null)
    onQuoteConsumed()
    setBusy(true)

    const userTurn: ChatTurn = {
      role: 'user',
      content: q || '（请就上面这段展开）',
      quote: usedQuote,
      ts: Date.now(),
    }
    const withUser = [...turnsRef.current, userTurn]
    persist(withUser)

    const ac = new AbortController()
    abortRef.current = ac
    try {
      const provider = makeProvider(cfg)
      const queryText = [usedQuote, q].filter(Boolean).join('\n')
      const [qvec] = await provider.embed([queryText])
      const hits = await retrieve(bookId, qvec, 8)
      if (ac.signal.aborted) return
      const ctx = hits.map((h, i) => `[${i + 1}] ${h.chunk.text}`).join('\n\n')
      const system =
        '你是帮助读者深入理解书籍的助手。结合「原文片段」和此前的对话回答；' +
        '引用原文用 [编号] 标注。原文不足以回答就直说，不要编造。中文，清晰简洁。'
      const history: ChatMessage[] = turnsRef.current
        .slice(-HISTORY_TURNS)
        .map((t) => ({ role: t.role, content: t.role === 'user' && t.quote ? `「${t.quote}」\n${t.content}` : t.content }))
      const userMsg =
        (usedQuote ? `【选中段落】\n${usedQuote}\n\n` : '') +
        `【相关原文片段】\n${ctx}\n\n【问题】\n${q || '请解释上面这段，并联系全书。'}`

      const assistant: ChatTurn = { role: 'assistant', content: '', sources: hits.map((h) => ({ cfi: h.chunk.cfi, text: h.chunk.text })), ts: Date.now() }
      let acc = [...turnsRef.current, assistant]
      turnsRef.current = acc
      setTurns(acc)

      await provider.chat({
        system,
        messages: [...history, { role: 'user', content: userMsg }],
        signal: ac.signal,
        maxTokens: 1024,
        onToken: (t) => {
          assistant.content += t
          acc = [...turnsRef.current.slice(0, -1), { ...assistant }]
          turnsRef.current = acc
          setTurns(acc)
        },
      })
      persist(turnsRef.current)
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        appendSystemNote('出错了：' + (e as Error).message.slice(0, 120))
      }
    } finally {
      setBusy(false)
    }
  }

  function appendSystemNote(text: string) {
    persist([...turnsRef.current, { role: 'assistant', content: text, ts: Date.now() }])
  }

  function doClear() {
    if (!turns.length || confirm('清空这本书的 AI 对话？')) {
      clearChat(bookId).catch(() => {})
      turnsRef.current = []
      setTurns([])
    }
  }

  // ---- drag the handle to resize between snaps ----
  function onHandleDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = height
    const move = (ev: PointerEvent) => {
      const h = Math.max(64, Math.min(window.innerHeight * 0.94, startH + (startY - ev.clientY)))
      setDragH(h)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const h = Math.max(64, startH + (startY - ev.clientY))
      // snap to the nearest of peek/half/full
      const order: Snap[] = ['peek', 'half', 'full']
      let best: Snap = 'half'
      let bestD = Infinity
      for (const s of order) {
        const d = Math.abs(snapHeight(s) - h)
        if (d < bestD) { bestD = d; best = s }
      }
      setDragH(null)
      setSnap(best)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return createPortal(
    <div className="chat-sheet" style={{ height }}>
      <div className="chat-handle" onPointerDown={onHandleDown}>
        <div className="chat-grip" />
      </div>
      <div className="chat-head">
        <span className="chat-title">AI 对话</span>
        <div className="chat-head-actions">
          <button className="chat-link" onClick={doClear} disabled={busy}>清空</button>
          <button className="chat-x" onClick={onClose} aria-label="收起">×</button>
        </div>
      </div>

      <div className="chat-list" ref={listRef}>
        {turns.length === 0 && (
          <div className="chat-empty">选中正文里的一段，点「问 AI」，就能基于全书追问。</div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={'chat-turn ' + t.role}>
            {t.quote && <div className="chat-turn-quote">{t.quote}</div>}
            <div className="chat-bubble">{t.content || (busy && i === turns.length - 1 ? '…' : '')}</div>
            {t.role === 'assistant' && t.sources && t.sources.length > 0 && (
              <div className="chat-sources">
                {t.sources.slice(0, 6).map((s, j) => (
                  <button
                    key={j}
                    className="chat-src"
                    disabled={!s.cfi}
                    onClick={() => {
                      if (s.cfi) { jumpTo(s.cfi); setSnap('peek') }
                    }}
                  >
                    [{j + 1}] {s.text.slice(0, 28)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {pendingQuote && (
        <div className="chat-pending">
          <span className="chat-pending-text">{pendingQuote}</span>
          <button className="chat-pending-x" onClick={() => { setPendingQuote(null); onQuoteConsumed() }}>×</button>
        </div>
      )}

      <div className="chat-input-row">
        <input
          className="ai-input"
          value={input}
          placeholder={pendingQuote ? '追问这段……（可留空）' : '问问这本书……'}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) send() }}
        />
        <button className="ios-btn primary" disabled={busy} onClick={send}>
          {busy ? '…' : '发送'}
        </button>
      </div>
    </div>,
    document.body,
  )
}
