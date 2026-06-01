// Generates a minimal valid EPUB (stored ZIP, no deps) for testing the reader.
import { writeFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'

function zipStore(files) {
  // files: [{ name, data: Buffer }]  -> a ZIP using STORE (no compression)
  const enc = (s) => Buffer.from(s, 'utf8')
  const chunks = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = enc(f.name)
    const data = Buffer.isBuffer(f.data) ? f.data : enc(f.data)
    const crc = crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method = store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0, 12) // date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(0, 34) // external attrs
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)
    offset += local.length + name.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const centralOffset = offset
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...chunks, centralBuf, end])
}

const chapter = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1>${body}</body></html>`

const para = (n) =>
  `<p>这是第 ${n} 段示例文字。选中这段话即可划线，并在原地写下你的想法。` +
  `The quick brown fox jumps over the lazy dog. 记录的物理成本越接近于零，越愿意记。</p>`

const ch1 = chapter('第一章 开始', Array.from({ length: 8 }, (_, i) => para(i + 1)).join('\n'))
const ch2 = chapter('第二章 继续', Array.from({ length: 8 }, (_, i) => para(i + 9)).join('\n'))

const files = [
  { name: 'mimetype', data: 'application/epub+zip' },
  {
    name: 'META-INF/container.xml',
    data: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  },
  {
    name: 'OEBPS/content.opf',
    data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:sample-0001</dc:identifier>
    <dc:title>阅读器示例书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`,
  },
  {
    name: 'OEBPS/nav.xhtml',
    data: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">第一章 开始</a></li>
  <li><a href="ch2.xhtml">第二章 继续</a></li>
</ol></nav></body></html>`,
  },
  { name: 'OEBPS/ch1.xhtml', data: ch1 },
  { name: 'OEBPS/ch2.xhtml', data: ch2 },
]

writeFileSync('sample.epub', zipStore(files))
console.log('wrote sample.epub')
