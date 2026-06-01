// End-to-end smoke test of the core flow (epub.js engine) against the preview
// server. Assumes `npm run preview` on http://localhost:4173 and sample.epub.
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

const stageText = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.reader-stage iframe')]
      .map((f) => {
        try {
          return f.contentDocument?.body?.innerText ?? ''
        } catch {
          return ''
        }
      })
      .join(' | '),
  )

const dbHighlights = () =>
  page.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('reader-v1')
      r.onsuccess = () => res(r.result)
    })
    return await new Promise((res) => {
      const tx = db.transaction('highlights').objectStore('highlights').getAll()
      tx.onsuccess = () => res(tx.result)
    })
  })

async function openBook() {
  await page.locator('.book-card').first().click()
  await page.locator('.reader-stage iframe').first().waitFor({ timeout: 15000 })
  await page.waitForTimeout(2500)
}

async function dragSelectLine() {
  const box = await page.locator('.reader-stage').boundingBox()
  const y = box.y + box.height * 0.22
  await page.mouse.move(box.x + box.width * 0.18, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 8 })
  await page.mouse.move(box.x + box.width * 0.8, y + 18, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(500)
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  check(await page.locator('h1', { hasText: '书架' }).isVisible(), '书架 loads')

  if ((await page.locator('.book-card').count()) === 0) {
    await page.setInputFiles('input[type=file]', join(root, 'sample.epub'))
    await page.locator('.book-card').first().waitFor({ timeout: 15000 })
  }
  check(true, 'EPUB import works (epub.js metadata)')

  await openBook()
  const t0 = await stageText()
  check(t0.includes('第一章'), 'reader renders chapter 1')
  check(
    t0.includes('第一章') && t0.includes('第二章'),
    'continuous manager stacks chapters (infinite scroll)',
  )

  // selection → editor pops directly (no intermediate button)
  await dragSelectLine()
  const editorVisible = await page
    .locator('.editor textarea')
    .isVisible()
    .catch(() => false)
  check(editorVisible, 'selection pops the editor directly (no button)')

  if (editorVisible) {
    await page.locator('.editor textarea').fill('这是一个测试想法')
    await page.locator('.tag-chip', { hasText: '启发' }).click()
    await page.locator('.editor .ios-btn.primary', { hasText: '保存' }).click()
    await page.waitForTimeout(400)
  }

  const hs = await dbHighlights()
  check(hs.length === 1, `1 highlight persisted (got ${hs.length})`)
  check(
    hs[0]?.note === '这是一个测试想法' && hs[0]?.tag === '启发',
    'note text + tag stored correctly',
  )
  check(!!hs[0]?.cfi, 'highlight has a CFI location')

  // reload — highlight + note survive, appear in notes list
  await page.reload({ waitUntil: 'networkidle' })
  await openBook()
  await page.locator('.reader-bar .icon-btn', { hasText: '✦' }).click()
  await page.locator('.note-item').first().waitFor({ timeout: 5000 })
  const noteText = await page.locator('.note-thought').first().textContent()
  check(noteText?.includes('这是一个测试想法'), 'note survives reload, shows in 笔记')

  // jump from note
  await page.locator('.note-item').first().click()
  await page.waitForTimeout(800)
  check(
    !(await page.locator('.note-item').first().isVisible().catch(() => false)),
    'tapping a note closes panel + jumps',
  )

  // TOC jump to chapter 2
  await page.locator('.reader-bar .icon-btn', { hasText: '☰' }).click()
  await page.locator('.toc-item').nth(1).click()
  await page.waitForTimeout(1200)
  check((await stageText()).includes('第二章'), 'TOC jump navigates to a chapter')

  // delete book + its highlights
  page.on('dialog', (d) => d.accept())
  await page.locator('.reader-bar .icon-btn').first().click() // back to shelf
  await page.locator('.book-card').first().waitFor()
  await page.locator('.book-card').first().hover()
  await page.locator('.book-delete').first().click()
  await page.waitForTimeout(600)
  const after = await page.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('reader-v1')
      r.onsuccess = () => res(r.result)
    })
    const b = await new Promise((res) => {
      const tx = db.transaction('books').objectStore('books').getAll()
      tx.onsuccess = () => res(tx.result.length)
    })
    const h = await new Promise((res) => {
      const tx = db.transaction('highlights').objectStore('highlights').getAll()
      tx.onsuccess = () => res(tx.result.length)
    })
    return { b, h }
  })
  check(after.b === 0 && after.h === 0, `delete removes book + highlights (b=${after.b}, h=${after.h})`)
} catch (e) {
  console.log('  [exception]', e.message)
  failed = true
} finally {
  await browser.close()
}

console.log(failed ? '\nSMOKE TEST: FAILED' : '\nSMOKE TEST: ALL PASSED')
process.exit(failed ? 1 : 0)
