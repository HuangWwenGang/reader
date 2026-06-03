import { useEffect, useRef, useState } from 'react'
import {
  addBook,
  deleteBook,
  exportAllData,
  getBooks,
} from '../lib/db'
import { extractMeta } from '../lib/epub'
import type { Book } from '../lib/types'
import AISettings from './AISettings'

function CoverImage({ book }: { book: Book }) {
  const [url, setUrl] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    setBroken(false)
    if (book.cover && book.cover.byteLength > 0) {
      const u = URL.createObjectURL(new Blob([book.cover]))
      setUrl(u)
      return () => URL.revokeObjectURL(u)
    }
    setUrl(null)
  }, [book.cover])

  if (url && !broken) {
    return (
      <div className="cover">
        <img src={url} alt={book.title} onError={() => setBroken(true)} />
      </div>
    )
  }
  return (
    <div className="cover">
      <div className="cover-placeholder">{book.title}</div>
    </div>
  )
}

export default function Bookshelf({
  onOpenBook,
}: {
  onOpenBook: (id: string) => void
}) {
  const [books, setBooks] = useState<Book[]>([])
  const [importing, setImporting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [showAI, setShowAI] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function refresh() {
    setBooks(await getBooks())
  }

  useEffect(() => {
    refresh()
  }, [])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setImporting(true)
    try {
      for (const file of Array.from(files)) {
        if (!file.name.toLowerCase().endsWith('.epub')) {
          showToast('只支持 .epub 文件')
          continue
        }
        const buf = await file.arrayBuffer()
        const meta = await extractMeta(buf)
        const book: Book = {
          id: crypto.randomUUID(),
          title: meta.title,
          author: meta.author,
          cover: meta.cover ?? null,
          file: buf,
          createdAt: Date.now(),
        }
        await addBook(book)
      }
      await refresh()
    } catch (e) {
      console.error(e)
      showToast('导入失败：' + (e as Error).message)
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleDelete(book: Book, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`删除《${book.title}》？\n该书的所有划线和想法也会一并删除。`)) return
    await deleteBook(book.id)
    await refresh()
  }

  async function handleExport() {
    const data = await exportAllData()
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().slice(0, 10)
    a.download = `reader-export-${stamp}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast('已导出全部数据')
  }

  return (
    <div className="shelf">
      <div className="shelf-header">
        <h1>书架</h1>
        <div className="shelf-actions">
          <button className="btn" onClick={() => setShowAI(true)}>
            AI 设置
          </button>
          <button className="btn" onClick={handleExport} disabled={books.length === 0}>
            导出数据
          </button>
          <button
            className="btn btn-primary"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            {importing ? '导入中…' : '导入 EPUB'}
          </button>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".epub,application/epub+zip"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => handleFiles(e.target.files)}
      />

      {books.length === 0 ? (
        <div className="empty">
          书架是空的。
          <br />
          点击右上角「导入 EPUB」开始阅读。
        </div>
      ) : (
        <div className="grid">
          {books.map((book) => (
            <div
              className="book-card"
              key={book.id}
              onClick={() => onOpenBook(book.id)}
            >
              <button
                className="book-delete"
                title="删除"
                onClick={(e) => handleDelete(book, e)}
              >
                ×
              </button>
              <CoverImage book={book} />
              <div className="book-title">{book.title}</div>
              {book.author && <div className="book-author">{book.author}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="build-badge">
        版本 {__APP_VERSION__.length > 16 ? __APP_VERSION__.slice(0, 7) : __APP_VERSION__}
      </div>

      {toast && <div className="toast">{toast}</div>}
      {showAI && <AISettings onClose={() => setShowAI(false)} />}
    </div>
  )
}
