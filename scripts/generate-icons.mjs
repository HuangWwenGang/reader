// Generates app icons as raw PNGs (no native deps — uses Node's zlib).
// Design: warm brown background with a cream "book" rectangle and a spine line.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
mkdirSync(outDir, { recursive: true })

const BG = [124, 111, 100] // #7c6f64 warm brown
const PAPER = [250, 249, 247] // #faf9f7 cream
const SPINE = [124, 111, 100]

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function makePng(size) {
  const px = (x, y) => {
    // book occupies a centered region
    const m = size * 0.2
    const inBook = x > m && x < size - m && y > m * 1.1 && y < size - m * 1.1
    if (!inBook) return BG
    // spine in the middle
    const spineHalf = size * 0.012
    if (Math.abs(x - size / 2) < spineHalf) return SPINE
    return PAPER
  }

  // raw image data: each row prefixed with filter byte 0
  const raw = Buffer.alloc((size * 3 + 1) * size)
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b] = px(x, y)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const idat = deflateSync(raw)
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const size of [180, 192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), makePng(size))
  console.log(`wrote icon-${size}.png`)
}

// also an SVG favicon
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#7c6f64"/>
  <rect x="102" y="112" width="308" height="288" rx="8" fill="#faf9f7"/>
  <rect x="250" y="112" width="12" height="288" fill="#7c6f64"/>
</svg>`
writeFileSync(join(outDir, 'icon.svg'), svg)
console.log('wrote icon.svg')
