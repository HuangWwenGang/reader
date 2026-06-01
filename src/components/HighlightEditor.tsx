import { useLayoutEffect, useRef, useState } from 'react'
import type { AnchorRect } from '../lib/geometry'
import { placePopup } from '../lib/geometry'
import { TAG_COLORS, TAGS } from '../lib/tags'

export interface EditorTarget {
  highlightId?: string // present = editing an existing highlight; absent = new
  cfi: string
  text: string
  note: string
  tag?: string
  anchor: AnchorRect
  autoFocus?: boolean
}

export default function HighlightEditor({
  target,
  onSave,
  onCancel,
  onDelete,
}: {
  target: EditorTarget
  onSave: (note: string, tag: string | undefined) => void
  onCancel: () => void
  onDelete: () => void
}) {
  const [note, setNote] = useState(target.note)
  const [tag, setTag] = useState<string | undefined>(target.tag)
  const ref = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const isExisting = !!target.highlightId

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos(placePopup(target.anchor, rect.width, rect.height))
    if (target.autoFocus) {
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        const len = ta.value.length
        ta.setSelectionRange(len, len)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.cfi])

  function toggleTag(t: string) {
    setTag((cur) => (cur === t ? undefined : t))
  }

  return (
    <div
      ref={ref}
      className="editor"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="editor-quote">{target.text}</div>
      <textarea
        ref={textareaRef}
        value={note}
        placeholder="写下你的想法…"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            onSave(note.trim(), tag)
          }
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="tag-row">
        {TAGS.map((t) => (
          <button
            key={t}
            className={'tag-chip' + (tag === t ? ' active' : '')}
            style={
              tag === t
                ? { background: TAG_COLORS[t], borderColor: TAG_COLORS[t] }
                : undefined
            }
            onClick={() => toggleTag(t)}
            type="button"
          >
            {t}
          </button>
        ))}
      </div>
      <div className="editor-actions">
        {isExisting ? (
          <button className="link-danger" onClick={onDelete} type="button">
            删除
          </button>
        ) : (
          <span />
        )}
        <div className="right">
          <button className="ios-btn" onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="ios-btn primary"
            onClick={() => onSave(note.trim(), tag)}
            type="button"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
