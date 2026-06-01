// Verifies clicking an existing highlight opens the editor and it STAYS open
// (regression: iOS ghost-click on the backdrop closed it immediately).
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 420, height: 760 } })
let failed = false
const check = (c, m) => { console.log(`• ${c ? 'PASS' : 'FAIL'} — ${m}`); if (!c) failed = true }
try {
  await p.goto('http://localhost:4173', { waitUntil: 'networkidle' })
  if ((await p.locator('.book-card').count()) === 0) {
    await p.setInputFiles('input[type=file]', join(root, 'sample.epub'))
    await p.locator('.book-card').first().waitFor({ timeout: 15000 })
  }
  await p.locator('.book-card').first().click()
  await p.locator('.reader-stage iframe').first().waitFor({ timeout: 15000 })
  await p.waitForTimeout(2500)
  const box = await p.locator('.reader-stage').boundingBox()
  const y = box.y + box.height * 0.22
  // create a highlight
  await p.mouse.move(box.x + box.width * 0.18, y)
  await p.mouse.down()
  await p.mouse.move(box.x + box.width * 0.8, y, { steps: 8 })
  await p.mouse.move(box.x + box.width * 0.8, y + 18, { steps: 4 })
  await p.mouse.up()
  await p.waitForTimeout(600)
  await p.locator('.editor textarea').fill('flicker test')
  await p.locator('.editor .ios-btn.primary', { hasText: '保存' }).click()
  await p.waitForTimeout(400)
  // now click the highlight; scan a few y to land on it
  let opened = false
  for (const fy of [0.2, 0.22, 0.18, 0.24, 0.16]) {
    await p.mouse.click(box.x + box.width * 0.4, box.y + box.height * fy)
    await p.waitForTimeout(700) // long enough that a ghost-close would have happened
    opened = await p.locator('.editor textarea').isVisible().catch(() => false)
    if (opened) break
  }
  check(opened, 'clicking a highlight opens the editor AND it stays open (no flicker)')
} catch (e) {
  console.log('  [exception]', e.message); failed = true
} finally {
  await b.close()
}
console.log(failed ? '\nFLICKER TEST: FAILED' : '\nFLICKER TEST: PASSED')
process.exit(failed ? 1 : 0)
