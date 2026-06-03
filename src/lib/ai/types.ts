// V2 RAG layer — shared types for chunks, vectors, providers and config.

// A retrievable unit of text. Book paragraphs and the user's own highlights/notes
// are both chunks; notes carry extra weight at retrieval time.
export interface Chunk {
  id: string // `${bookId}:b${seq}` for book text, `${bookId}:h${highlightId}` for notes
  bookId: string
  seq: number // order within the book (for stable sorting / display)
  sectionIndex: number // spine index the chunk came from
  cfi: string // start CFI — lets an answer jump back to the source
  text: string
  source: 'book' | 'note' // 'note' = a highlight (+ the thought written on it)
  tag?: string // highlight tag, when source = 'note'
}

// Embedding stored separately from the text payload so similarity search streams
// only the floats. `vec` is a Float32Array (structured-clone friendly in idb).
export interface ChunkVector {
  id: string // == chunk id
  bookId: string
  vec: Float32Array
}

// Per-book index status, shown in the UI and used to resume indexing.
export interface BookIndexMeta {
  bookId: string
  state: 'none' | 'indexing' | 'ready' | 'error'
  model: string // embedding model the vectors were built with
  dim: number // embedding dimensionality
  chunkCount: number
  sectionsDone: number
  sectionsTotal: number
  error?: string
  updatedAt: number
}

// ---- AI provider abstraction (vendor-pluggable) ----

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  system?: string
  messages: ChatMessage[]
  signal?: AbortSignal
  onToken?: (delta: string) => void // streaming callback; full text also returned
  maxTokens?: number
}

export interface AIProvider {
  // Embed a batch of texts → one Float32Array per input, same order.
  embed(texts: string[]): Promise<Float32Array[]>
  // Generate a chat completion. Streams via onToken when provided.
  chat(opts: ChatOptions): Promise<string>
  readonly embedModel: string
  readonly embedDim: number
}

// Which wire protocol the chat endpoint speaks. 'openai' = OpenAI-compatible
// (/chat/completions) — what most third-party relays expose, often proxying
// Claude too. 'anthropic' = native Anthropic /messages.
export type ChatVendor = 'anthropic' | 'openai'

export interface AIConfig {
  chatVendor: ChatVendor
  anthropicKey: string
  openaiKey: string // also used for embeddings
  // API base URLs — override to point at a third-party relay. Should end in the
  // version segment (e.g. https://your-relay.com/v1). Embeddings always use the
  // OpenAI-compatible base.
  openaiBaseUrl: string
  anthropicBaseUrl: string
  chatModel: string
  embedModel: string
}
