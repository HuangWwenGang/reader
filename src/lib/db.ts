import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Book, Highlight } from './types'

interface ReaderDB extends DBSchema {
  books: {
    key: string
    value: Book
    indexes: { createdAt: number }
  }
  highlights: {
    key: string
    value: Highlight
    indexes: { bookId: string }
  }
  // cached per-section pixel heights for the virtual scroller, keyed by
  // `${bookId}:${layoutHash}` (heights depend on font/spacing/width)
  heights: {
    key: string
    value: { key: string; heights: number[]; complete?: boolean }
  }
}

let dbPromise: Promise<IDBPDatabase<ReaderDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<ReaderDB>('reader-v1', 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const books = db.createObjectStore('books', { keyPath: 'id' })
          books.createIndex('createdAt', 'createdAt')
          const highlights = db.createObjectStore('highlights', { keyPath: 'id' })
          highlights.createIndex('bookId', 'bookId')
        }
        if (oldVersion < 2) {
          db.createObjectStore('heights', { keyPath: 'key' })
        }
      },
    })
  }
  return dbPromise
}

// ---- Section height cache (virtual scroller) ----

export async function getHeights(key: string): Promise<number[] | undefined> {
  const db = await getDB()
  const rec = await db.get('heights', key)
  return rec?.heights
}

// Whether the whole-book background premeasure finished for this layout. If not,
// the cached heights are partial (estimates for chapters not yet reached) and
// premeasure should run again to fill the gaps.
export async function getHeightsComplete(key: string): Promise<boolean> {
  const db = await getDB()
  const rec = await db.get('heights', key)
  return !!rec?.complete
}

export async function saveHeights(
  key: string,
  heights: number[],
  complete = false,
): Promise<void> {
  const db = await getDB()
  await db.put('heights', { key, heights, complete })
}

// ---- Books ----

export async function getBooks(): Promise<Book[]> {
  const db = await getDB()
  const all = await db.getAllFromIndex('books', 'createdAt')
  // newest first
  return all.reverse()
}

export async function getBook(id: string): Promise<Book | undefined> {
  const db = await getDB()
  return db.get('books', id)
}

export async function addBook(book: Book): Promise<void> {
  const db = await getDB()
  await db.put('books', book)
}

export async function updateBookLocation(id: string, cfi: string): Promise<void> {
  const db = await getDB()
  const book = await db.get('books', id)
  if (!book) return
  book.lastLocation = cfi
  await db.put('books', book)
}

export async function saveBookLocations(id: string, json: string): Promise<void> {
  const db = await getDB()
  const book = await db.get('books', id)
  if (!book) return
  book.locations = json
  await db.put('books', book)
}

// Delete a book and all of its highlights (PRD §3.2).
export async function deleteBook(id: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['books', 'highlights'], 'readwrite')
  await tx.objectStore('books').delete(id)
  const hStore = tx.objectStore('highlights')
  const keys = await hStore.index('bookId').getAllKeys(id)
  await Promise.all(keys.map((k) => hStore.delete(k)))
  await tx.done
}

// ---- Highlights ----

export async function getHighlights(bookId: string): Promise<Highlight[]> {
  const db = await getDB()
  return db.getAllFromIndex('highlights', 'bookId', bookId)
}

export async function saveHighlight(h: Highlight): Promise<void> {
  const db = await getDB()
  await db.put('highlights', h)
}

export async function deleteHighlight(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('highlights', id)
}

// ---- Export (PRD §3.6) ----

export async function exportAllData(): Promise<unknown> {
  const db = await getDB()
  const books = await db.getAll('books')
  const highlights = await db.getAll('highlights')
  // Books carry binary blobs (epub + cover) which can't go into JSON.
  // Export the notes/metadata — the user's core asset — and omit file bodies.
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    books: books.map(({ file, cover, ...rest }) => {
      void file
      void cover
      return rest
    }),
    highlights,
  }
}
