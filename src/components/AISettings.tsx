import { useState } from 'react'
import { loadAIConfig, saveAIConfig } from '../lib/ai/config'
import { makeProvider } from '../lib/ai/providers'
import type { AIConfig } from '../lib/ai/types'

// Global AI configuration: point chat + embeddings at the official APIs or any
// third-party relay (OpenAI-compatible covers most). Keys live on-device only.
export default function AISettings({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<AIConfig>(() => loadAIConfig())
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  function patch(p: Partial<AIConfig>) {
    setCfg((c) => {
      const next = { ...c, ...p }
      saveAIConfig(next)
      return next
    })
  }

  async function testConnection() {
    setTesting(true)
    setResult(null)
    const provider = makeProvider(cfg)
    const lines: string[] = []
    try {
      const v = await provider.embed(['连接测试'])
      lines.push(`✓ 向量：成功（${v[0]?.length ?? 0} 维）`)
    } catch (e) {
      lines.push(`✗ 向量：${(e as Error).message.slice(0, 120)}`)
    }
    try {
      const reply = await provider.chat({
        messages: [{ role: 'user', content: '只回复两个字：成功' }],
        maxTokens: 16,
      })
      lines.push(`✓ 问答：${reply.trim().slice(0, 30) || '（空回复）'}`)
    } catch (e) {
      lines.push(`✗ 问答：${(e as Error).message.slice(0, 120)}`)
    }
    setResult(lines.join('\n'))
    setTesting(false)
  }

  const isOpenAI = cfg.chatVendor === 'openai'

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet ai-sheet">
        <div className="sheet-handle" />
        <div className="ai-title">AI 设置</div>

        <div className="sheet-row">
          <span className="sheet-label">问答协议</span>
          <div className="seg">
            <button
              className={'seg-btn' + (isOpenAI ? ' active' : '')}
              onClick={() => patch({ chatVendor: 'openai' })}
            >
              OpenAI 兼容
            </button>
            <button
              className={'seg-btn' + (!isOpenAI ? ' active' : '')}
              onClick={() => patch({ chatVendor: 'anthropic' })}
            >
              Anthropic 原生
            </button>
          </div>
        </div>

        {isOpenAI ? (
          <>
            <div className="ai-hint">
              问答与向量走同一个 OpenAI 兼容接口（填你的中转地址 + Key 即可）。
            </div>
            <Field label="接口地址" value={cfg.openaiBaseUrl}
              placeholder="https://你的中转.com/v1"
              onChange={(v) => patch({ openaiBaseUrl: v })} />
            <Field label="API Key" value={cfg.openaiKey} secret
              onChange={(v) => patch({ openaiKey: v })} />
            <Field label="问答模型" value={cfg.chatModel}
              placeholder="gpt-4o-mini / claude-3-5-sonnet…"
              onChange={(v) => patch({ chatModel: v })} />
            <Field label="向量模型" value={cfg.embedModel}
              placeholder="text-embedding-3-small"
              onChange={(v) => patch({ embedModel: v })} />
          </>
        ) : (
          <>
            <div className="ai-hint">问答用 Anthropic 原生接口；向量仍走 OpenAI 兼容接口。</div>
            <Field label="问答地址" value={cfg.anthropicBaseUrl}
              placeholder="https://api.anthropic.com/v1"
              onChange={(v) => patch({ anthropicBaseUrl: v })} />
            <Field label="问答 Key" value={cfg.anthropicKey} secret
              onChange={(v) => patch({ anthropicKey: v })} />
            <Field label="问答模型" value={cfg.chatModel}
              placeholder="claude-sonnet-4-6"
              onChange={(v) => patch({ chatModel: v })} />
            <Field label="向量地址" value={cfg.openaiBaseUrl}
              placeholder="https://你的中转.com/v1"
              onChange={(v) => patch({ openaiBaseUrl: v })} />
            <Field label="向量 Key" value={cfg.openaiKey} secret
              onChange={(v) => patch({ openaiKey: v })} />
            <Field label="向量模型" value={cfg.embedModel}
              placeholder="text-embedding-3-small"
              onChange={(v) => patch({ embedModel: v })} />
          </>
        )}

        {result && <pre className="ai-result">{result}</pre>}

        <div className="ai-actions">
          <button className="ios-btn" onClick={testConnection} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="ios-btn primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  secret?: boolean
}) {
  return (
    <label className="ai-field">
      <span className="ai-field-label">{label}</span>
      <input
        className="ai-input"
        type={secret ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
