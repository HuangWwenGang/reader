// AI configuration (API keys + model choices), persisted in localStorage.
// Personal, single-user app: keys live on-device and calls go straight to the
// vendor from the browser. Never logged or synced.
import type { AIConfig } from './types'

const KEY = 'reader-ai-config'

export const DEFAULT_AI_CONFIG: AIConfig = {
  chatVendor: 'openai', // OpenAI-compatible covers most third-party relays
  anthropicKey: '',
  openaiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  anthropicBaseUrl: 'https://api.anthropic.com/v1',
  chatModel: 'gpt-4o-mini',
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
