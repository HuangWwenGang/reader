// AI configuration (API keys + model choices), persisted in localStorage.
// Personal, single-user app: keys live on-device and calls go straight to the
// vendor from the browser. Never logged or synced.
import type { AIConfig } from './types'

const KEY = 'reader-ai-config'

export const DEFAULT_AI_CONFIG: AIConfig = {
  chatVendor: 'anthropic',
  anthropicKey: '',
  openaiKey: '',
  chatModel: 'claude-sonnet-4-6',
  embedModel: 'text-embedding-3-small',
}

export function loadAIConfig(): AIConfig {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT_AI_CONFIG, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_AI_CONFIG }
}

export function saveAIConfig(c: AIConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    /* ignore */
  }
}

// Embeddings always need an OpenAI key; chat needs the selected vendor's key.
export function aiReady(c: AIConfig): { embed: boolean; chat: boolean } {
  return {
    embed: !!c.openaiKey,
    chat: c.chatVendor === 'anthropic' ? !!c.anthropicKey : !!c.openaiKey,
  }
}
