import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Book, Highlight } from './types'
import type {
  Chunk,
  ChunkVector,
  BookIndexMeta,
  BookChat,
  ChatSession,
} from './ai/types'

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
  // ---- V2 RAG layer ----
  // retrievable text chunks (book paragraphs + the user's highlights/notes)
  chunks: {
    key: string
    value: Chunk
    indexes: { bookId: string }
  }
  // embedding vector per chunk (kept separate so similarity search can stream
  // just the floats without the text payload)
  vectors: {
    key: string
    value: ChunkVector
    indexes: { bookId: string }
  }
  // per-book index status (model, dims, progress, done)
  aimeta: {
    key: string
    value: BookIndexMeta
  }
  // persistent AI chat thread, one per book (legacy, kept for migration)
  chats: {
    key: string
    value: BookChat
  }
  // multiple AI conversations per book
  sessions: {
    key: string
    value: ChatSession
    indexes: { bookId: string }
  }
}

let dbPromise: Promise<IDBPDatabase<ReaderDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<ReaderDB>('reader-v1', 5, {
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
        if (oldVersion < 3) {
          const chunks = db.createObjectStore('chunks', { keyPath: 'id' })
          chunks.createIndex('bookId', 'bookId')
          const vectors = db.createObjectStore('vectors', { keyPath: 'id' })
          vectors.createIndex('bookId', 'bookId')
          db.createObjectStore('aimeta', { keyPath: 'bookId' })
        }
        if (oldVersion < 4) {
          db.createObjectStore('chats', { keyPath: 'bookId' })
        }
        if (oldVersion < 5) {
          const sessions = db.createObjectStore('sessions', { keyPath: 'id' })
          sessions.createIndex('bookId', 'bookId')
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

// Delete a book and all of its highlights + RAG index (PRD §3.2).
export async function deleteBook(id: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(
    ['books', 'highlights', 'chunks', 'vectors', 'aimeta', 'chats', 'sessions'],
    'readwrite',
  )
  await tx.objectStore('books').delete(id)
  for (const store of ['highlights', 'chunks', 'vectors', 'sessions'] as const) {
    const s = tx.objectStore(store)
    const keys = await s.index('bookId').getAllKeys(id)
    await Promise.all(keys.map((k) => s.delete(k)))
  }
  await tx.objectStore('aimeta').delete(id)
  await tx.objectStore('chats').delete(id)
  await tx.done
}

// ---- RAG: chunks + vectors + index meta ----

export async function getBookIndexMeta(
  bookId: string,
): Promise<BookIndexMeta | undefined> {
  const db = await getDB()
  return db.get('aimeta', bookId)
}

export async function saveBookIndexMeta(meta: BookIndexMeta): Promise<void> {
  const db = await getDB()
  await db.put('aimeta', meta)
}

// Replace a book's entire index (chunks + vectors) in one transaction.
export async function saveChunksWithVectors(
  bookId: string,
  items: { chunk: Chunk; vec: Float32Array }[],
): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['chunks', 'vectors'], 'readwrite')
  const cStore = tx.objectStore('chunks')
  const vStore = tx.objectStore('vectors')
  for (const { chunk, vec } of items) {
    cStore.put(chunk)
    vStore.put({ id: chunk.id, bookId, vec })
  }
  await tx.done
}

export async function clearBookIndex(bookId: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['chunks', 'vectors'], 'readwrite')
  for (const store of ['chunks', 'vectors'] as const) {
    const s = tx.objectStore(store)
    const keys = await s.index('bookId').getAllKeys(bookId)
    await Promise.all(keys.map((k) => s.delete(k)))
  }
  await tx.done
}

// All vectors for a book — small enough (a few MB) to brute-force cosine search.
export async function getBookVectors(bookId: string): Promise<ChunkVector[]> {
  const db = await getDB()
  return db.getAllFromIndex('vectors', 'bookId', bookId)
}

// All chunks for a book (text payloads) — used for keyword/lexical retrieval.
export async function getBookChunks(bookId: string): Promise<Chunk[]> {
  const db = await getDB()
  return db.getAllFromIndex('chunks', 'bookId', bookId)
}

export async function getChunksByIds(ids: string[]): Promise<Chunk[]> {
  const db = await getDB()
  const out = await Promise.all(ids.map((id) => db.get('chunks', id)))
  return out.filter((c): c is Chunk => !!c)
}

export async function getBookChunkCount(bookId: string): Promise<number> {
  const db = await getDB()
  return db.countFromIndex('chunks', 'bookId', bookId)
}

// ---- per-book AI chat sessions (multiple conversations) ----

export async function getSessions(bookId: string): Promise<ChatSession[]> {
  const db = await getDB()
  const all = await db.getAllFromIndex('sessions', 'bookId', bookId)
  return all.sort((a, b) => b.updatedAt - a.updatedAt) // newest first
}

export async function getSession(id: string): Promise<ChatSession | undefined> {
  const db = await getDB()
  return db.get('sessions', id)
}

export async function saveSession(s: ChatSession): Promise<void> {
  const db = await getDB()
  await db.put('sessions', s)
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('sessions', id)
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
