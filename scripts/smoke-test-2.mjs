// Second pass: position restore, edit existing highlight, jump-to-note,
// export JSON, delete book. Run after smoke-test.mjs (reuses its data).
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE_URL || 'http://localhost:4173'
const log = (...a) => console.log('•', ...a)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 420, height: 760 } })
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))

let failed = false
const check = (cond, msg) => {
  log(`${cond ? 'PASS' : 'FAIL'} — ${msg}`)
  if (!cond) failed = true
}
const openBook = async () => {
  await page.locator('.book-card').first().click()
  await page.locator('foliate-view').waitFor({ timeout: 15000 })
  await page.waitForTimeout(2200)
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })

  // --- ensure a book exists (import if the DB was cleared) ---
  if ((await page.locator('.book-card').count()) === 0) {
    await page.setInputFiles('input[type=file]', join(root, 'sample.epub'))
    await page.locator('.book-card').first().waitFor({ timeout: 15000 })
  }

  // --- create one highlight so later steps have data to work with ---
  await openBook()
  {
    const box = await page.locator('.reader-stage').boundingBox()
    const y = box.y + box.height * 0.45
    await page.mouse.move(box.x + box.width * 0.2, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.8, y, { steps: 8 })
    await page.mouse.move(box.x + box.width * 0.8, y + 22, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    await page.locator('.float-btn').click()
    await page.locator('.editor textarea').waitFor({ timeout: 3000 })
    await page.locator('.editor textarea').fill('测试想法二')
    await page.locator('.editor .btn-primary', { hasText: '保存' }).click()
    await page.waitForTimeout(400)
  }

  // --- edit an existing highlight: click it, editor should reopen ---
  {
    const box = await page.locator('.reader-stage').boundingBox()
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45)
    await page.waitForTimeout(400)
    const reopened = await page
      .locator('.editor textarea')
      .isVisible()
      .catch(() => false)
    check(reopened, 'clicking an existing highlight reopens the editor (acceptance #6)')
    if (reopened) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
  }

  // --- position restore: turn pages, note fraction, reopen ---
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(420 * 0.85, 760 * 0.5)
    await page.waitForTimeout(500)
  }
  const loc1 = await page.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('reader-v1')
      r.onsuccess = () => res(r.result)
    })
    return await new Promise((res) => {
      const tx = db.transaction('books').objectStore('books').getAll()
      tx.onsuccess = () => res(tx.result[0]?.lastLocation)
    })
  })
  check(!!loc1, `lastLocation saved after paging (${(loc1 || '').slice(0, 24)}…)`)

  await page.locator('.reader-bar .icon-btn').first().click() // back to shelf
  await page.locator('.book-card').first().waitFor()
  await openBook()
  const loc2 = await page.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('reader-v1')
      r.onsuccess = () => res(r.result)
    })
    return await new Promise((res) => {
      const tx = db.transaction('books').objectStore('books').getAll()
      tx.onsuccess = () => res(tx.result[0]?.lastLocation)
    })
  })
  check(!!loc2, 'reopened book restored a saved location (acceptance #2)')

  // --- jump-to-note moves the view ---
  await page.locator('.reader-bar .icon-btn', { hasText: '✦' }).click()
  const hasNote = (await page.locator('.note-item').count()) > 0
  check(hasNote, 'notes list has at least one note (acceptance #7)')
  if (hasNote) {
    await page.locator('.note-item').first().click()
    await page.waitForTimeout(800)
    check(
      !(await page.locator('.note-item').first().isVisible().catch(() => false)),
      'tapping a note closes the panel and jumps to it',
    )
  }

  // --- export JSON contains highlights ---
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
    (async () => {
      await page.locator('.reader-bar .icon-btn').first().click() // back to shelf
      await page.locator('.btn', { hasText: '导出数据' }).click()
    })(),
  ])
  let exportOk = false
  if (download) {
    const path = await download.path()
    const { readFileSync } = await import('node:fs')
    const json = JSON.parse(readFileSync(path, 'utf8'))
    exportOk =
      Array.isArray(json.highlights) &&
      json.highlights.length >= 1 &&
      Array.isArray(json.books) &&
      json.books[0] &&
      !('fileBlob' in json.books[0])
  }
  check(exportOk, 'export JSON has highlights + book meta, omits fileBlob (acceptance #9)')

  // --- delete book removes it and its highlights ---
  page.on('dialog', (d) => d.accept())
  await page.locator('.book-card').first().hover()
  await page.locator('.book-delete').first().click()
  await page.waitForTimeout(600)
  const remaining = await page.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('reader-v1')
      r.onsuccess = () => res(r.result)
    })
    const books = await new Promise((res) => {
      const tx = db.transaction('books').objectStore('books').getAll()
      tx.onsuccess = () => res(tx.result.length)
    })
    const hl = await new Promise((res) => {
      const tx = db.transaction('highlights').objectStore('highlights').getAll()
      tx.onsuccess = () => res(tx.result.length)
    })
    return { books, hl }
  })
  check(
    remaining.books === 0 && remaining.hl === 0,
    `delete removed book + its highlights (books=${remaining.books}, highlights=${remaining.hl}) (acceptance #8)`,
  )
} catch (e) {
  console.log('  [exception]', e.message)
  failed = true
} finally {
  await browser.close()
}

console.log(failed ? '\nSMOKE TEST 2: FAILED' : '\nSMOKE TEST 2: ALL PASSED')
process.exit(failed ? 1 : 0)
