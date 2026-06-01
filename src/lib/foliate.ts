// Thin wrapper around the vendored foliate-js modules in /public/foliate-js.
// These are plain ES modules loaded at runtime (not bundled by Vite), so we use
// dynamic import with @vite-ignore and treat them as untyped.

// Respect Vite's base URL so the absolute module paths resolve correctly when
// the app is hosted under a subpath (e.g. GitHub Pages /<repo>/). BASE_URL ends
// with a trailing slash.
const BASE = `${import.meta.env.BASE_URL}foliate-js`

let viewModulePromise: Promise<any> | null = null

// Loads view.js, which registers the <foliate-view> custom element and exports
// makeBook(). Safe to call repeatedly.
export function loadFoliate(): Promise<any> {
  if (!viewModulePromise) {
    viewModulePromise = import(/* @vite-ignore */ `${BASE}/view.js`)
  }
  return viewModulePromise
}

export interface FoliateView extends HTMLElement {
  open(book: Blob | any): Promise<void>
  init(opts: { lastLocation?: string; showTextStart?: boolean }): Promise<void>
  goTo(target: string): Promise<any>
  goLeft(): void
  goRight(): void
  prev(distance?: number): Promise<void>
  next(distance?: number): Promise<void>
  getCFI(index: number, range: Range): string
  addAnnotation(annotation: { value: string }, remove?: boolean): Promise<any>
  deleteAnnotation(annotation: { value: string }): Promise<any>
  deselect(): void
  renderer: any
  book: any
  history: any
}

function formatLanguageMap(x: any): string {
  if (!x) return ''
  if (typeof x === 'string') return x
  const keys = Object.keys(x)
  return x[keys[0]] ?? ''
}

function formatContributor(c: any): string {
  const one = (x: any) =>
    typeof x === 'string' ? x : formatLanguageMap(x?.name)
  if (Array.isArray(c)) return c.map(one).filter(Boolean).join(', ')
  return one(c)
}

export interface BookMeta {
  title: string
  author?: string
  cover?: Blob | null
}

// Parse an EPUB file just enough to get shelf metadata (title/author/cover).
export async function extractMeta(file: Blob): Promise<BookMeta> {
  const { makeBook } = await loadFoliate()
  const book = await makeBook(file)
  const title = formatLanguageMap(book.metadata?.title) || '未命名书籍'
  const author = formatContributor(book.metadata?.author) || undefined
  let cover: Blob | null = null
  try {
    cover = (await book.getCover?.()) ?? null
  } catch {
    cover = null
  }
  return { title, author, cover }
}

let overlayerModulePromise: Promise<any> | null = null

// Loads the Overlayer class used to draw highlight rects.
export async function getOverlayer(): Promise<any> {
  if (!overlayerModulePromise) {
    overlayerModulePromise = import(/* @vite-ignore */ `${BASE}/overlayer.js`)
  }
  return (await overlayerModulePromise).Overlayer
}

let cfiModulePromise: Promise<any> | null = null

// Returns a comparator for CFIs, used to sort notes by position in the book.
// Falls back to string compare if the module fails to load.
export async function getCFIComparator(): Promise<
  (a: string, b: string) => number
> {
  try {
    if (!cfiModulePromise) {
      cfiModulePromise = import(/* @vite-ignore */ `${BASE}/epubcfi.js`)
    }
    const mod = await cfiModulePromise
    return (a: string, b: string) => mod.compare(a, b)
  } catch {
    return (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  }
}

// CSS injected into each book's iframe document. We explicitly paint the
// background + text color from the chosen theme and force `color-scheme: light`
// so the book content NEVER follows the OS dark mode independently of the app
// chrome (that was the black-on-cream clash). Font size / line height / flow are
// all driven from user settings.
import type { Settings } from './settings'
import { THEMES } from './settings'

export function getReaderCSS(settings: Settings): string {
  const c = THEMES[settings.theme]
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: light;
      background: ${c.bg} !important;
      color: ${c.ink} !important;
      font-size: ${settings.fontScale}%;
    }
    body {
      background: ${c.bg} !important;
      color: ${c.ink} !important;
    }
    p, li, blockquote, dd, h1, h2, h3, h4, h5, h6, span, div, td, th {
      color: ${c.ink};
    }
    a:link, a:visited { color: ${c.link}; }
    p, li, blockquote, dd {
      line-height: ${settings.lineHeight};
      text-align: justify;
      -webkit-hyphens: auto;
      hyphens: auto;
      hanging-punctuation: allow-end last;
      widows: 2;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    pre { white-space: pre-wrap !important; }
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] { display: none; }
  `
}
