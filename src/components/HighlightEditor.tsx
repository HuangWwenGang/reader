import { useLayoutEffect, useRef, useState } from 'react'
import type { AnchorRect } from '../lib/geometry'
import { placePopup } from '../lib/geometry'
import { TAG_COLORS, TAGS } from '../lib/tags'

export interface EditorTarget {
  highlightId: string
  text: string
  note: string
  tag?: string
  anchor: AnchorRect
  autoFocus?: boolean // focus the textarea (pops keyboard) — only when creating
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

  // Position after first paint (need real measured size), then focus the input
  // so the user can type immediately without moving their hand (PRD §3.4).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos(placePopup(target.anchor, rect.width, rect.height))
    // focus + caret at end — only when creating a new highlight, so opening an
    // existing one to read/edit doesn't pop the keyboard (PRD §3.4 vs editing)
    if (target.autoFocus) {
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        const len = ta.value.length
        ta.setSelectionRange(len, len)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.highlightId])

  function toggleTag(t: string) {
    setTag((cur) => (cur === t ? undefined : t))
  }

  return (
    <div
      ref={ref}
      className="editor"
      style={
        pos
          ? { left: pos.left, top: pos.top }
          : { left: -9999, top: -9999 } // pre-measure offscreen
      }
      onClick={(e) => e.stopPropagation()}
    >
      <div className="editor-quote">{target.text}</div>
      <textarea
        ref={textareaRef}
        value={note}
        placeholder="写下你对这段的想法…（可留空）"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter to save quickly
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
            onClick={() => toggleTag(t)}
            type="button"
          >
            <span className="dot" style={{ background: TAG_COLORS[t] }} />
            {t}
          </button>
        ))}
      </div>
      <div className="editor-actions">
        <button className="link-danger" onClick={onDelete} type="button">
          删除划线
        </button>
        <div className="right">
          <button className="btn btn-ghost" onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="btn btn-primary"
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
