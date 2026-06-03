import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getBookIndexMeta } from '../lib/db'
import { aiReady, loadAIConfig } from '../lib/ai/config'
import { makeProvider } from '../lib/ai/providers'
import { retrieve, type RetrievedChunk } from '../lib/ai/retrieve'

type Status = 'idle' | 'retrieving' | 'answering' | 'done' | 'error'

const QUICK = [
  '解释这段在说什么',
  '它和全书的核心论点有什么关系',
  '有哪些可质疑之处',
]

// 选中即问：基于选中的段落 + 全书向量检索，让模型作答，答案带可跳转的原文引用。
export default function AskPanel({
  bookId,
  quote,
  onJump,
  onClose,
}: {
  bookId: string
  quote: string
  onJump: (cfi: string) => void
  onClose: () => void
}) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [sources, setSources] = useState<RetrievedChunk[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [err, setErr] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const answerRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    answerRef.current?.scrollTo({ top: answerRef.current.scrollHeight })
  }, [answer])

  async function ask(q: string) {
    const query = q.trim()
    const cfg = loadAIConfig()
    const ready = aiReady(cfg)
    if (!ready.embed || !ready.chat) {
      setErr('请先在书架的「AI 设置」里填好接口和 Key')
      setStatus('error')
      return
    }
    const meta = await getBookIndexMeta(bookId)
    if (meta?.state !== 'ready') {
      setErr('这本书还没建立索引——请先回书架，点这本书的「建立索引」')
      setStatus('error')
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setErr('')
    setAnswer('')
    setSources([])
    setStatus('retrieving')
    try {
      const provider = makeProvider(cfg)
      const [qvec] = await provider.embed([query || quote])
      const hits = await retrieve(bookId, qvec, 8)
      if (ac.signal.aborted) return
      setSources(hits)
      setStatus('answering')
      const ctx = hits
        .map((h, i) => `[${i + 1}] ${h.chunk.text}`)
        .join('\n\n')
      const system =
        '你是帮助读者深入理解书籍的助手。只依据下面提供的「原文片段」回答；' +
        '引用时用 [编号] 标注来源。原文不足以回答就直说，不要编造。用中文，清晰、有条理、简洁。'
      const userMsg =
        `【选中段落】\n${quote}\n\n` +
        `【相关原文片段】\n${ctx}\n\n` +
        `【问题】\n${query || '请解释这段在说什么，并联系全书的相关内容。'}`
      await provider.chat({
        system,
        messages: [{ role: 'user', content: userMsg }],
        signal: ac.signal,
        maxTokens: 1024,
        onToken: (t) => setAnswer((a) => a + t),
      })
      if (!ac.signal.aborted) setStatus('done')
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      setErr((e as Error).message)
      setStatus('error')
    }
  }

  const busy = status === 'retrieving' || status === 'answering'

  return createPortal(
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="ask-modal">
        <div className="ask-head">
          <span className="ask-title">问 AI</span>
          <button className="ask-x" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="ask-quote">{quote}</div>

        <div className="ask-input-row">
          <input
            className="ai-input"
            value={question}
            placeholder="问问这段……（留空则让它解释）"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) ask(question)
            }}
          />
          <button className="ios-btn primary" disabled={busy} onClick={() => ask(question)}>
            {busy ? '…' : '问'}
          </button>
        </div>

        <div className="ask-chips">
          {QUICK.map((q) => (
            <button
              key={q}
              className="tag-chip"
              disabled={busy}
              onClick={() => {
                setQuestion(q)
                ask(q)
              }}
            >
              {q}
            </button>
          ))}
        </div>

        {status === 'retrieving' && <div className="ask-status">正在检索全书相关段落…</div>}
        {err && <div className="ask-error">{err}</div>}

        {(answer || status === 'answering') && (
          <div className="ask-answer" ref={answerRef}>
            {answer}
            {status === 'answering' && <span className="ask-caret">▋</span>}
          </div>
        )}

        {sources.length > 0 && (
          <div className="ask-sources">
            <div className="ask-sources-title">引用原文（点击跳回）</div>
            {sources.map((s, i) => (
              <button
                key={s.chunk.id}
                className="ask-source"
                disabled={!s.chunk.cfi}
                onClick={() => s.chunk.cfi && (onJump(s.chunk.cfi), onClose())}
              >
                <span className="ask-source-n">[{i + 1}]</span>
                <span className="ask-source-text">
                  {s.chunk.source === 'note' ? '✎ ' : ''}
                  {s.chunk.text.slice(0, 60)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>,
    document.body,
  )
}
