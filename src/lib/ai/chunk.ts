// Pure text chunking for RAG. No DOM, no network — unit-testable.
//
// Strategy: break the text into "pieces" (paragraphs; a paragraph longer than
// the target is split on sentence boundaries; a sentence longer than the target
// is hard-split), each carrying its real char offset into the source. Then pack
// consecutive pieces greedily into chunks of ~targetChars. Offsets stay exact so
// a chunk can later be mapped back to a CFI.

export interface TextChunk {
  text: string
  start: number // char offset into the original text
  end: number
}

const SENT_END = /([。！？!?；;]|\n)/

function splitSentences(para: string): string[] {
  const out: string[] = []
  let buf = ''
  const parts = para.split(SENT_END)
  for (let i = 0; i < parts.length; i++) {
    buf += parts[i]
    if (i % 2 === 1) {
      // odd indices are the captured delimiters
      out.push(buf)
      buf = ''
    }
  }
  if (buf) out.push(buf)
  return out.filter((s) => s.length > 0)
}

interface Piece {
  text: string
  start: number
}

export function chunkText(
  raw: string,
  targetChars = 320,
  _overlapChars = 0, // reserved; piece-level packing keeps offsets exact
): TextChunk[] {
  const text = raw.replace(/\r\n?/g, '\n')
  const pieces: Piece[] = []

  const pushHardSplit = (s: string, start: number) => {
    for (let i = 0; i < s.length; i += targetChars) {
      const part = s.slice(i, i + targetChars)
      if (part.trim()) pieces.push({ text: part, start: start + i })
    }
  }

  const paraRe = /[^\n]+/g
  let m: RegExpExecArray | null
  while ((m = paraRe.exec(text))) {
    const lead = m[0].length - m[0].trimStart().length
    const trimmed = m[0].trim()
    if (!trimmed) continue
    const pStart = m.index + lead
    if (trimmed.length <= targetChars) {
      pieces.push({ text: trimmed, start: pStart })
    } else {
      let off = pStart
      for (const s of splitSentences(trimmed)) {
        if (s.length <= targetChars) pieces.push({ text: s, start: off })
        else pushHardSplit(s, off)
        off += s.length
      }
    }
  }

  const chunks: TextChunk[] = []
  let cur: Piece[] = []
  let curLen = 0
  const flush = () => {
    if (!cur.length) return
    const start = cur[0].start
    const last = cur[cur.length - 1]
    const end = last.start + last.text.length
    const t = cur.map((p) => p.text).join('\n').trim()
    if (t) chunks.push({ text: t, start, end })
    cur = []
    curLen = 0
  }
  for (const p of pieces) {
    if (curLen > 0 && curLen + p.text.length > targetChars) flush()
    cur.push(p)
    curLen += p.text.length + 1 // +1 for the join '\n'
  }
  flush()
  return chunks
}
