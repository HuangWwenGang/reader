import SidePanel from './SidePanel'
import { colorForTag } from '../lib/tags'
import type { Highlight } from '../lib/types'

export default function NotesPanel({
  highlights,
  onJump,
  onClose,
}: {
  highlights: Highlight[] // already sorted by position in the book
  onJump: (h: Highlight) => void
  onClose: () => void
}) {
  return (
    <SidePanel title={`笔记 · ${highlights.length}`} onClose={onClose}>
      {highlights.length === 0 ? (
        <div className="empty">
          还没有划线。
          <br />
          在阅读时选中文字即可划线并写下想法。
        </div>
      ) : (
        highlights.map((h) => (
          <div key={h.id} className="note-item" onClick={() => onJump(h)}>
            <div className="note-text">{h.text}</div>
            {h.note && <div className="note-thought">{h.note}</div>}
            {h.tag && (
              <div className="note-meta">
                <span
                  className="note-tag"
                  style={{ background: colorForTag(h.tag) }}
                >
                  {h.tag}
                </span>
              </div>
            )}
          </div>
        ))
      )}
    </SidePanel>
  )
}
