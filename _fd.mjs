import { chromium } from 'playwright'
import { join } from 'node:path'
const root = process.cwd()
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 420, height: 760 } })
p.on('pageerror', e=>console.log('[err]',e.message))
await p.goto('http://localhost:4173', { waitUntil: 'networkidle' })
await p.evaluate(() => new Promise((res)=>{ const r=indexedDB.deleteDatabase('reader-v1'); r.onsuccess=r.onerror=()=>res() }))
await p.reload({ waitUntil: 'networkidle' })
await p.setInputFiles('input[type=file]', join(root,'sample.epub'))
await p.locator('.book-card').first().waitFor({timeout:15000})
await p.locator('.book-card').first().click()
await p.locator('.reader-stage iframe').first().waitFor({timeout:15000})
await p.waitForTimeout(2500)
await p.evaluate(() => window.vr.goTo('OEBPS/ch2.xhtml#sec2'))
await p.waitForTimeout(1200)
const top = await p.evaluate(() => {
  const sc = document.querySelector('.reader-stage > div')
  const scTop = sc.getBoundingClientRect().top
  for (const ifr of sc.querySelectorAll('iframe')) {
    const fr = ifr.getBoundingClientRect()
    if (fr.top-2 <= scTop+3 && fr.bottom > scTop+3) {
      try { const r = ifr.contentDocument.caretRangeFromPoint(60,(scTop+3)-fr.top); return r?.startContainer?.parentElement?.closest('p')?.innerText?.slice(0,14) } catch { return 'ERR' }
    }
  }
  return 'none'
})
console.log('RESULT top:', JSON.stringify(top), '|', String(top).includes('锚点') ? 'PASS' : 'FAIL')
await b.close()
