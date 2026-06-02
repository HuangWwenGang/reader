// Tests the bug the virtual reader is meant to fix: read FORWARD into new
// content, exit, reopen → should restore to where you were (not revert).
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 420, height: 760 } })
p.on('pageerror', (e) => console.log('  [pageerror]', e.message))
let failed = false
const check = (c, m) => { console.log(`• ${c ? 'PASS' : 'FAIL'} — ${m}`); if (!c) failed = true }

const cfi = () => p.evaluate(() => window.vr?.currentCfi?.())
const dbLoc = () => p.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('reader-v1'); r.onsuccess = () => res(r.result) })
  return await new Promise((res) => { const tx = db.transaction('books').objectStore('books').getAll(); tx.onsuccess = () => res(tx.result[0]?.lastLocation) })
})
const topText = () => p.evaluate(() => {
  const sc = document.querySelector('.reader-stage > div')
  if (!sc) return ''
  // find the iframe whose slot spans the viewport top
  for (const slot of sc.querySelectorAll(':scope > div > div')) {
    const r = slot.getBoundingClientRect()
    if (r.top <= sc.getBoundingClientRect().top + 5 && r.bottom > sc.getBoundingClientRect().top + 5) {
      const ifr = slot.querySelector('iframe')
      try { return ifr?.contentDocument?.body?.innerText?.slice(0, 24) } catch { return '' }
    }
  }
  return ''
})
async function openBook() {
  await p.locator('.book-card').first().click()
  await p.locator('.reader-stage iframe').first().waitFor({ timeout: 15000 })
  await p.waitForTimeout(2500)
}

await p.goto('http://localhost:4173', { waitUntil: 'networkidle' })
if ((await p.locator('.book-card').count()) === 0) {
  await p.setInputFiles('input[type=file]', join(root, 'sample.epub'))
  await p.locator('.book-card').first().waitFor({ timeout: 15000 })
}
await openBook()

// read FORWARD: scroll down into chapter 2
const box = await p.locator('.reader-stage').boundingBox()
for (let i = 0; i < 18; i++) {
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await p.mouse.wheel(0, 450)
  await p.waitForTimeout(100)
}
await p.waitForTimeout(800)
const cfiBefore = await cfi()
const topBefore = await topText()
console.log('  before exit: cfi=', JSON.stringify(cfiBefore), 'top=', JSON.stringify(topBefore))

// exit to shelf, then reopen
await p.locator('.float-ctrl.back').click()
await p.locator('.book-card').first().waitFor()
await p.waitForTimeout(400)
console.log('  db lastLocation:', JSON.stringify(await dbLoc()))
await openBook()
await p.waitForTimeout(1000)
const cfiAfter = await cfi()
const topAfter = await topText()
console.log('  after reopen: cfi=', JSON.stringify(cfiAfter), 'top=', JSON.stringify(topAfter))

check(!!cfiBefore, 'got a CFI while reading forward')
check(cfiBefore && cfiAfter && cfiBefore === cfiAfter, 'reopen restores the SAME position (forward-read, no revert)')
check(topBefore && topAfter && topBefore === topAfter, 'same content at viewport top after reopen')

await b.close()
console.log(failed ? '\nVR POSITION: FAILED' : '\nVR POSITION: PASSED')
process.exit(failed ? 1 : 0)
