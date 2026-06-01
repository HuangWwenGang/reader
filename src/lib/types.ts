// Data model — see PRD §6.

export interface Book {
  id: string
  title: string
  author?: string
  cover?: Blob | null
  fileBlob: Blob // the epub file itself
  lastLocation?: string // foliate-js CFI, for restoring reading position
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
