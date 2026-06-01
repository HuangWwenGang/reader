// Reader appearance + layout settings, persisted in localStorage.

export type ThemeName = 'paper' | 'sepia' | 'night'
export type FlowMode = 'scrolled' | 'paginated'

export interface Settings {
  theme: ThemeName
  fontScale: number // percent of base font size
  lineHeight: number
  flow: FlowMode
}

export interface ThemeColors {
  bg: string
  ink: string
  muted: string
  line: string
  card: string
  accent: string
  link: string
}

// One source of truth for colors — used for both the app chrome (CSS variables)
// and the book content (injected into the foliate iframe), so they never clash.
export const THEMES: Record<ThemeName, ThemeColors> = {
  paper: {
    bg: '#faf9f7',
    ink: '#2b2b2b',
    muted: '#8a8580',
    line: '#e7e3dd',
    card: '#ffffff',
    accent: '#7c6f64',
    link: '#3a6ea5',
  },
  sepia: {
    bg: '#f4ecd8',
    ink: '#5b4636',
    muted: '#9c8a6f',
    line: '#e3d8bf',
    card: '#faf3e2',
    accent: '#a07b46',
    link: '#9a5b34',
  },
  night: {
    bg: '#16161a',
    ink: '#cdc9c2',
    muted: '#7d7a73',
    line: '#2c2c33',
    card: '#202027',
    accent: '#b8a890',
    link: '#9db7d6',
  },
}

export const THEME_LABELS: Record<ThemeName, string> = {
  paper: '纸张',
  sepia: '护眼',
  night: '夜间',
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'night',
  fontScale: 110,
  lineHeight: 1.7,
  flow: 'scrolled',
}

const KEY = 'reader-settings'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

// Apply theme colors to the app chrome by setting CSS variables on :root.
export function applyTheme(theme: ThemeName): void {
  const c = THEMES[theme]
  const root = document.documentElement.style
  root.setProperty('--paper', c.bg)
  root.setProperty('--ink', c.ink)
  root.setProperty('--muted', c.muted)
  root.setProperty('--line', c.line)
  root.setProperty('--card', c.card)
  root.setProperty('--accent', c.accent)
  // also drive the browser/PWA chrome
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', c.bg)
}
