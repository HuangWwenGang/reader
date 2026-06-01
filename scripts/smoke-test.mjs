// End-to-end smoke test of the core flow against the preview server.
// Assumes `npm run preview` is running on http://localhost:4173 and that
// sample.epub exists at the repo root.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE_URL || 'http://localhost:4173'
const log = (...a) => console.log('•', ...a)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 420, height: 760 } })
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [browser error]', m.text())
})
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))

let failed = false
const check = (cond, msg) => {
  log(`${cond ? 'PASS' : 'FAIL'} — ${msg}`)
  if (!cond) failed = true
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  check(await page.locator('h1', { hasText: '书架' }).isVisible(), '书架 loads')

  // import sample.epub via the hidden file input
  await page.setInputFiles('input[type=file]', join(root, 'sample.epub'))
  await page.locator('.book-card').first().waitFor({ timeout: 15000 })
  check(true, 'sample.epub imported, appears on shelf')

  // open the book
  await page.locator('.book-card').first().click()
  await page.locator('foliate-view').waitFor({ timeout: 15000 })
  // give foliate time to render the first section
  await page.waitForTimeout(2500)
  check(await page.locator('foliate-view').isVisible(), 'reader renders foliate-view')

  // drag-select a line of text in the middle of the page (real input events,
  // so it works through foliate's closed shadow DOM)
  const box = await page.locator('.reader-stage').boundingBox()
  const y = box.y + box.height * 0.45
  await page.mouse.move(box.x + box.width * 0.2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 8 })
  await page.mouse.move(box.x + box.width * 0.8, y + 22, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(400)

  const floatVisible = await page.locator('.float-btn').isVisible().catch(() => false)
  check(floatVisible, 'selection shows the “划线并写想法” button')

  if (floatVisible) {
    await page.locator('.float-btn').click()
    await page.locator('.editor textarea').waitFor({ timeout: 3000 })
    const focused = await page.evaluate(
      () => document.activeElement?.tagName === 'TEXTAREA',
    )
    check(focused, 'editor opens with textarea auto-focused')

    await page.locator('.editor textarea').fill('这是一个测试想法')
    await page.locator('.tag-chip', { hasText: '启发' }).click()
    await page.locator('.editor .btn-primary', { hasText: '保存' }).click()
    await page.waitForTimeout(400)
  }

  // verify persistence in IndexedDB
  const countAfterSave = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('reader-v1')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    return await new Promise((res) => {
      const tx = db.transaction('highlights').objectStore('highlights').getAll()
      tx.onsuccess = () => res(tx.result)
    })
  })
  check(countAfterSave.length === 1, `1 highlight persisted (got ${countAfterSave.length})`)
  check(
    countAfterSave[0]?.note === '这是一个测试想法' && countAfterSave[0]?.tag === '启发',
    'note text + tag stored correctly',
  )
  check(!!countAfterSave[0]?.cfi, 'highlight has a CFI location')

  // reload — highlight + note must survive
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.book-card').first().click()
  await page.locator('foliate-view').waitFor({ timeout: 15000 })
  await page.waitForTimeout(2000)
  // open notes panel
  await page.locator('.reader-bar .icon-btn', { hasText: '✦' }).click()
  await page.locator('.note-item').first().waitFor({ timeout: 5000 })
  const noteText = await page.locator('.note-thought').first().textContent()
  check(noteText?.includes('这是一个测试想法'), 'note survives reload and shows in 笔记 list')
} catch (e) {
  console.log('  [exception]', e.message)
  failed = true
} finally {
  await browser.close()
}

console.log(failed ? '\nSMOKE TEST: FAILED' : '\nSMOKE TEST: ALL PASSED')
process.exit(failed ? 1 : 0)
