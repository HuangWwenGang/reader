// Diagnose reading-position restore: scroll, exit, reopen, compare position.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 420, height: 760 } })
p.on('pageerror', (e) => console.log('  [pageerror]', e.message))

const loc = () =>
  p.evaluate(() => {
    try {
      const l = window.rendition?.currentLocation?.()
      return { cfi: l?.start?.cfi, pct: l?.start?.percentage, href: l?.start?.href }
    } catch (e) {
      return { err: String(e) }
    }
  })
const dbLoc = () =>
  p.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('reader-v1')
      r.onsuccess = () => res(r.result)
    })
    return await new Promise((res) => {
      const tx = db.transaction('books').objectStore('books').getAll()
      tx.onsuccess = () => res(tx.result[0]?.lastLocation)
    })
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

// scroll down a good amount
const box = await p.locator('.reader-stage').boundingBox()
for (let i = 0; i < 12; i++) {
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await p.mouse.wheel(0, 500)
  await p.waitForTimeout(120)
}
await p.waitForTimeout(600)
const before = await loc()
console.log('BEFORE exit:', JSON.stringify(before))

// go back to shelf (triggers flush) then reopen
await p.locator('.reader-bar .icon-btn').first().click()
await p.locator('.book-card').first().waitFor()
await p.waitForTimeout(400)
console.log('DB lastLocation after exit:', JSON.stringify(await dbLoc()))

await openBook()
await p.waitForTimeout(1200)
const after = await loc()
console.log('AFTER reopen:', JSON.stringify(after))

const drift =
  before.pct != null && after.pct != null
    ? Math.abs(before.pct - after.pct)
    : null
console.log('PERCENT DRIFT:', drift)
console.log(
  drift != null && drift < 0.03
    ? 'POSITION RESTORE: GOOD (drift < 3%)'
    : 'POSITION RESTORE: DRIFTS (' + (drift != null ? (drift * 100).toFixed(1) + '%' : 'n/a') + ')',
)
await b.close()
