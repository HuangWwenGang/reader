// Reader appearance + layout settings, persisted in localStorage.

export type ThemeName = 'paper' | 'sepia' | 'night'
export type FlowMode = 'scrolled' | 'paginated'
export type FontKey = 'default' | 'sans' | 'serif'

export interface Settings {
  theme: ThemeName
  fontScale: number // percent of base font size
  lineHeight: number
  letterSpacing: number // em (character spacing)
  margin: number // horizontal page margin, percent of width
  justify: boolean // justify text vs. start-aligned
  bold: boolean // heavier text weight
  fontFamily: FontKey
  brightness: number // night-mode text brightness, 50–100
  flow: FlowMode
}

// Night-mode text color from a brightness level (50 = soft gray, 100 = pure white).
export function nightInk(brightness: number): string {
  const b = Math.max(50, Math.min(100, brightness))
  const v = Math.round(140 + ((255 - 140) * (b - 50)) / 50)
  const h = v.toString(16).padStart(2, '0')
  return `#${h}${h}${h}`
}

// Font stacks for the book content.
export const FONTS: Record<FontKey, string> = {
  default: '', // keep the book's own fonts
  sans: '-apple-system, "PingFang SC", "Microsoft YaHei", "Heiti SC", sans-serif',
  serif: 'Georgia, "Songti SC", "SimSun", "Noto Serif CJK SC", serif',
}

export const FONT_LABELS: Record<FontKey, string> = {
  default: '默认',
  sans: '黑体',
  serif: '宋体',
}

export interface ThemeColors {
  bg: string
  ink: string
  muted: string
  line: string
  card: string
  accent: string
  link: string
  glass: string // translucent material for iOS-style popups (used with blur)
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
    glass: 'rgba(255, 255, 255, 0.72)',
  },
  sepia: {
    bg: '#f4ecd8',
    ink: '#5b4636',
    muted: '#9c8a6f',
    line: '#e3d8bf',
    card: '#faf3e2',
    accent: '#a07b46',
    link: '#9a5b34',
    glass: 'rgba(250, 243, 226, 0.74)',
  },
  // Deep true-black with bright text, like iOS Books' night mode — crisp,
  // high-contrast, comfortable on OLED.
  night: {
    bg: '#000000',
    ink: '#e9e7e2',
    muted: '#7b7b7b',
    line: '#222222',
    card: '#141414',
    accent: '#cbb791',
    link: '#a9c2e3',
    glass: 'rgba(28, 28, 30, 0.64)',
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
  lineHeight: 1.6,
  letterSpacing: 0,
  margin: 6,
  justify: false,
  bold: false,
  fontFamily: 'sans',
  brightness: 92,
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
  root.setProperty('--glass', c.glass)
  // also drive the browser/PWA chrome
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', c.bg)
}
