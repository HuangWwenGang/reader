// Data model — see PRD §6.

export interface Book {
  id: string
  title: string
  author?: string
  // Stored as ArrayBuffer (NOT Blob): iOS Safari backs IndexedDB Blobs with temp
  // files that get reclaimed, later throwing "The object can not be found here"
  // and breaking covers. ArrayBuffers are stored inline and stay valid.
  cover?: ArrayBuffer | null
  file: ArrayBuffer // the epub file bytes
  lastLocation?: string // epub CFI, for restoring reading position
  locations?: string // cached epub.js locations index (JSON), for accurate progress %
  createdAt: number
}

// Preset tags for highlights (PRD §3.4). `undefined`/'' means no tag.
export const TAGS = ['金句', '疑问', '启发', '反对', '待查'] as const
export type Tag = (typeof TAGS)[number]

export interface Highlight {
  id: string
  bookId: string
  cfi: string // precise location in the book
  text: string // the highlighted source text
  note?: string // the user's thought, may be empty
  tag?: string // optional category tag
  createdAt: number
  updatedAt: number
}
