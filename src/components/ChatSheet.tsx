import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  getBookIndexMeta,
  getSessions,
  saveSession,
  deleteSession,
} from '../lib/db'
import { aiReady, loadAIConfig } from '../lib/ai/config'
import { makeProvider } from '../lib/ai/providers'
import { retrieveHybrid, expandHits } from '../lib/ai/retrieve'
import type { ChatTurn, ChatMessage, ChatSession } from '../lib/ai/types'

type Snap = 'peek' | 'half' | 'full'
const SNAP_VH: Record<Snap, number> = { peek: 0.12, half: 0.52, full: 0.9 }
const HISTORY_TURNS = 8
const RETRIEVE_K = 12

const snapHeight = (s: Snap) => Math.round(window.innerHeight * SNAP_VH[s])
const newSession = (bookId: string): ChatSession => ({
  id: crypto.randomUUID(),
  bookId,
  title: '新对话',
  turns: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

export default function ChatSheet({
  bookId,
  bookTitle,
  bookAuthor,
  quote,
  onQuoteConsumed,
  jumpTo,
  onClose,
  onHeight,
}: {
  bookId: string
  bookTitle: string
  bookAuthor?: string
  quote: string | null
  onQuoteConsumed: () => void
  jumpTo: (cfi: string) => void
  onClose: () => void
  onHeight: (px: number) => void
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [current, setCurrent] = useState<ChatSession>(() => newSession(bookId))
  const [showList, setShowList] = useState(false)
  const [input, setInput] = useState('')
  const [pendingQuote, setPendingQuote] = useState<string | null>(quote)
  const [busy, setBusy] = useState(false)
  const [snap, setSnap] = useState<Snap>('half')
  const [dragH, setDragH] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const curRef = useRef<ChatSession>(current)
  curRef.current = current

  // load this book's sessions; open the most recent or a fresh one
  useEffect(() => {
    let alive = true
    getSessions(bookId).then((ss) => {
      if (!alive) return
      setSessions(ss)
      if (ss.length) setCurrent(ss[0])
    })
    return () => {
      alive = false
      abortRef.current?.abort()
    }
  }, [bookId])

  // a selection arrived from the reader → attach as quoted context
  useEffect(() => {
    if (quote) {
      setPendingQuote(quote)
      setSnap('half')
    }
  }, [quote])

  const height = dragH ?? snapHeight(snap)
  useEffect(() => onHeight(height), [height, onHeight])
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [current.turns])

  function setTurns(turns: ChatTurn[], persist = true) {
    const next = { ...curRef.current, turns, updatedAt: Date.now() }
    curRef.current = next
    setCurrent(next)
    if (persist) {
      saveSession(next).catch(() => {})
      setSessions((ss) => [next, ...ss.filter((s) => s.id !== next.id)])
    }
  }

  function startNew() {
    abortRef.current?.abort()
    const s = newSession(bookId)
    curRef.current = s
    setCurrent(s)
    setShowList(false)
  }

  function openSession(s: ChatSession) {
    abortRef.current?.abort()
    curRef.current = s
    setCurrent(s)
    setShowList(false)
  }

  async function removeSession(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm('删除这个对话？')) return
    await deleteSession(id)
    const ss = sessions.filter((s) => s.id !== id)
    setSessions(ss)
    if (curRef.current.id === id) {
      if (ss.length) openSession(ss[0])
      else startNew()
    }
  }

  function note(text: string) {
    setTurns([...curRef.current.turns, { role: 'assistant', content: text, ts: Date.now() }])
  }

  async function send() {
    const q = input.trim()
    if ((!q && !pendingQuote) || busy) return
    const cfg = loadAIConfig()
    const ready = aiReady(cfg)
    if (!ready.embed || !ready.chat) return note('请先在书架的「AI 设置」里填好接口和 Key。')
    const meta = await getBookIndexMeta(bookId)
    if (meta?.state !== 'ready') return note('这本书还没建立索引——请先回书架点这本书的「建立索引」。')

    const usedQuote = pendingQuote ?? undefined
    setInput('')
    setPendingQuote(null)
    onQuoteConsumed()
    setBusy(true)

    const isFirst = curRef.current.turns.length === 0
    const userTurn: ChatTurn = {
      role: 'user',
      content: q || '（请就上面这段展开）',
      quote: usedQuote,
      ts: Date.now(),
    }
    // auto-title a fresh conversation from the first question/quote
    if (isFirst) {
      curRef.current = {
        ...curRef.current,
        title: (q || usedQuote || '新对话').slice(0, 18),
      }
    }
    setTurns([...curRef.current.turns, userTurn])

    const ac = new AbortController()
    abortRef.current = ac
    try {
      const provider = makeProvider(cfg)
      const queryText = [usedQuote, q].filter(Boolean).join('\n')
      const [qvec] = await provider.embed([queryText])
      const hits = await retrieveHybrid(bookId, qvec, queryText, RETRIEVE_K)
      if (ac.signal.aborted) return
      const blocks = await expandHits(bookId, hits, 1)
      if (ac.signal.aborted) return
      const sources = hits.map((h) => ({ cfi: h.chunk.cfi, text: h.chunk.text }))

      const ctx = blocks.map((b, i) => `[${i + 1}]${b.source === 'note' ? '（我的笔记）' : ''} ${b.text}`).join('\n\n')
      const system =
        `你是帮助读者理解《${bookTitle}》${bookAuthor ? `（${bookAuthor}）` : ''}的阅读助手。这是一本严肃的非虚构作品。\n` +
        `严格遵守：\n` +
        `1. 只依据下面的「原文资料」回答,引用具体内容时用 [编号] 标注来源;\n` +
        `2. 绝不编造人物、情节、事实或书中没有的内容。若「原文资料」里没有与问题直接相关的内容,就明确说"检索到的原文里没有找到关于『…』的内容,可能这一节没被准确检索到",并建议用户换个说法、或在书里选中那一段再问——不要硬凑答案;\n` +
        `3. 不要把它当小说去总结"人物/情节",按它实际的论述与案例来回答;\n` +
        `4. 中文,有条理(可分点),忠于原文,不啰嗦。`
      const history: ChatMessage[] = curRef.current.turns
        .slice(0, -1)
        .slice(-HISTORY_TURNS)
        .map((t) => ({
          role: t.role,
          content: t.role === 'user' && t.quote ? `「${t.quote}」\n${t.content}` : t.content,
        }))
      const userMsg =
        `【原文资料】\n${ctx}\n\n` +
        (usedQuote ? `【我正在读的段落】\n${usedQuote}\n\n` : '') +
        `【问题】\n${q || '请解释我正在读的这段,并联系全书的相关内容。'}`

      const assistant: ChatTurn = { role: 'assistant', content: '', sources, ts: Date.now() }
      setTurns([...curRef.current.turns, assistant], false)
      await provider.chat({
        system,
        messages: [...history, { role: 'user', content: userMsg }],
        signal: ac.signal,
        maxTokens: 1500,
        onToken: (t) => {
          assistant.content += t
          setTurns([...curRef.current.turns.slice(0, -1), { ...assistant }], false)
        },
      })
      setTurns(curRef.current.turns) // final persist
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') note('出错了：' + (e as Error).message.slice(0, 120))
    } finally {
      setBusy(false)
    }
  }

  function onHandleDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = height
    const move = (ev: PointerEvent) =>
      setDragH(Math.max(64, Math.min(window.innerHeight * 0.94, startH + (startY - ev.clientY))))
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const h = Math.max(64, startH + (startY - ev.clientY))
      let best: Snap = 'half'
      let bestD = Infinity
      for (const s of ['peek', 'half', 'full'] as Snap[]) {
        const d = Math.abs(snapHeight(s) - h)
        if (d < bestD) { bestD = d; best = s }
      }
      setDragH(null)
      setSnap(best)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const turns = current.turns

  return createPortal(
    <div className="chat-sheet" style={{ height }}>
      <div className="chat-handle" onPointerDown={onHandleDown}>
        <div className="chat-grip" />
      </div>
      <div className="chat-head">
        <button className="chat-sess-btn" onClick={() => setShowList((v) => !v)}>
          <span className="chat-sess-title">{current.title}</span>
          <span className="chat-sess-caret">{showList ? '▴' : '▾'}</span>
        </button>
        <div className="chat-head-actions">
          <button className="chat-link" onClick={startNew} disabled={busy}>+ 新对话</button>
          <button className="chat-x" onClick={onClose} aria-label="收起">×</button>
        </div>
      </div>

      {showList ? (
        <div className="chat-list chat-sesslist">
          <button className="chat-sess-row new" onClick={startNew}>＋ 开启新对话</button>
          {sessions.length === 0 && <div className="chat-empty">还没有对话。</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={'chat-sess-row' + (s.id === current.id ? ' active' : '')}
              onClick={() => openSession(s)}
            >
              <div className="chat-sess-row-main">
                <div className="chat-sess-row-title">{s.title}</div>
                <div className="chat-sess-row-meta">{new Date(s.updatedAt).toLocaleString()}</div>
              </div>
              <button className="chat-sess-del" onClick={(e) => removeSession(s.id, e)}>🗑</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="chat-list" ref={listRef}>
          {turns.length === 0 && (
            <div className="chat-empty">问问这本书,或选中正文里的一段点「问 AI」。每次都会基于全书检索作答。</div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={'chat-turn ' + t.role}>
              {t.quote && <div className="chat-turn-quote">{t.quote}</div>}
              <div className="chat-bubble">{t.content || (busy && i === turns.length - 1 ? '…' : '')}</div>
              {t.role === 'assistant' && t.sources && t.sources.length > 0 && (
                <div className="chat-sources">
                  {t.sources.slice(0, 8).map((s, j) => (
                    <button
                      key={j}
                      className="chat-src"
                      disabled={!s.cfi}
                      onClick={() => { if (s.cfi) { jumpTo(s.cfi); setSnap('peek') } }}
                    >
                      [{j + 1}] {s.text.slice(0, 26)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!showList && pendingQuote && (
        <div className="chat-pending">
          <span className="chat-pending-text">{pendingQuote}</span>
          <button className="chat-pending-x" onClick={() => { setPendingQuote(null); onQuoteConsumed() }}>×</button>
        </div>
      )}

      {!showList && (
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
      )}
    </div>,
    document.body,
  )
}
