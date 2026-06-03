// Concrete AI providers. All calls go directly from the browser to the vendor
// (personal single-user app). Embeddings: OpenAI. Chat: Anthropic or OpenAI.
import type { AIConfig, AIProvider, ChatOptions } from './types'

// text-embedding-3-small = 1536 dims; -large = 3072.
const EMBED_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
}

async function openaiEmbed(
  key: string,
  model: string,
  texts: string[],
): Promise<Float32Array[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, input: texts }),
  })
  if (!res.ok) {
    throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`)
  }
  const json = await res.json()
  // keep input order
  const sorted = (json.data as { index: number; embedding: number[] }[]).sort(
    (a, b) => a.index - b.index,
  )
  return sorted.map((d) => Float32Array.from(d.embedding))
}

async function anthropicChat(
  key: string,
  model: string,
  opts: ChatOptions,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // required to call the API directly from a browser
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    signal: opts.signal,
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: !!opts.onToken,
    }),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)

  if (!opts.onToken || !res.body) {
    const json = await res.json()
    return (json.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
  }
  return readSSE(res.body, (evt) => {
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      return evt.delta.text as string
    }
    return ''
  }, opts.onToken)
}

async function openaiChat(
  key: string,
  model: string,
  opts: ChatOptions,
): Promise<string> {
  const messages = [
    ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
    ...opts.messages,
  ]
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    signal: opts.signal,
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      messages,
      stream: !!opts.onToken,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI chat ${res.status}: ${await res.text()}`)

  if (!opts.onToken || !res.body) {
    const json = await res.json()
    return json.choices?.[0]?.message?.content ?? ''
  }
  return readSSE(
    res.body,
    (evt) => evt.choices?.[0]?.delta?.content ?? '',
    opts.onToken,
  )
}

// Minimal SSE reader for streaming chat. `pick` extracts the text delta from a
// parsed event; deltas are concatenated and also pushed to onToken.
async function readSSE(
  body: ReadableStream<Uint8Array>,
  pick: (evt: any) => string,
  onToken: (delta: string) => void,
): Promise<string> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const data = s.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const delta = pick(JSON.parse(data))
        if (delta) {
          full += delta
          onToken(delta)
        }
      } catch {
        /* ignore non-JSON keepalives */
      }
    }
  }
  return full
}

export function makeProvider(config: AIConfig): AIProvider {
  const embedModel = config.embedModel
  return {
    embedModel,
    embedDim: EMBED_DIMS[embedModel] ?? 1536,
    embed: (texts) => {
      if (!config.openaiKey) throw new Error('缺少 OpenAI API Key（用于向量索引）')
      return openaiEmbed(config.openaiKey, embedModel, texts)
    },
    chat: (opts) => {
      if (config.chatVendor === 'anthropic') {
        if (!config.anthropicKey) throw new Error('缺少 Claude API Key')
        return anthropicChat(config.anthropicKey, config.chatModel, opts)
      }
      if (!config.openaiKey) throw new Error('缺少 OpenAI API Key')
      return openaiChat(config.openaiKey, config.chatModel, opts)
    },
  }
}
