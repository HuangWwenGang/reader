import { TAGS } from './types'

// Color per preset tag, used both for the highlight overlay and UI chips.
export const TAG_COLORS: Record<string, string> = {
  金句: '#e9b949', // amber
  疑问: '#5b8def', // blue
  启发: '#3aab6f', // green
  反对: '#e0533d', // red
  待查: '#9b7bd4', // purple
}

export const DEFAULT_HIGHLIGHT_COLOR = '#e9b949'

export function colorForTag(tag?: string): string {
  if (tag && TAG_COLORS[tag]) return TAG_COLORS[tag]
  return DEFAULT_HIGHLIGHT_COLOR
}

export { TAGS }
