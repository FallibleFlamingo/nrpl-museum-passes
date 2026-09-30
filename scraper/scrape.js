/**
 * NRPL Museum Pass Availability Scraper
 * ---------------------------------------
 * See README for background. This revision:
 *  - Treats "other-month-number" filler cells as a harmless 'other-month'
 *    state (leading/trailing days from adjacent months in the 5-week grid)
 *    instead of lumping them into 'unknown'.
 *  - Captures the actual calendar header/navigation HTML into SUMMARY.md
 *    so we can see the real "next month" control instead of guessing
 *    selectors blindly.
 *  - Still attempts to click a "next month" control if NEXT_MONTHS > 0,
 *    but now clearly reports in SUMMARY.md whether that succeeded.
 *
 * ENV VARS
 *   HEADLESS=0        show the browser window (local use only, not CI)
 *   DEBUG=1           save screenshots + HTML dumps
 *   MUSEUM_LIMIT=3    only scrape the first N museums (faster iteration)
 *   NEXT_MONTHS=1     click "next month" this many times before reading
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let museums = require('./museums.json');

const BASE_URL = 'https://nrpl.libcal.com/passes';
const HEADLESS = process.env.HEADLESS !== '0';
const DEBUG = process.env.DEBUG === '1';
const LIMIT = process.env.MUSEUM_LIMIT ? parseInt(process.env.MUSEUM_LIMIT, 10) : null;
const NEXT_MONTHS = process.env.NEXT_MONTHS ? parseInt(process.env.NEXT_MONTHS, 10) : 0;
const OUTPUT_PATH = path.join(__dirname, '..', 'docs', 'data', 'availability.json');
const DEBUG_DIR = path.join(__dirname, 'debug');
const SUMMARY_PATH = path.join(DEBUG_DIR, 'SUMMARY.md');

if (LIMIT) museums = museums.slice(0, LIMIT);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const NEXT_BUTTON_CANDIDATES = [
  '#s-lc-date-next',
  '.fc-next-button',
];

async function goToNextMonth(page, times) {
  for (let i = 0; i < times; i++) {
    let clicked = false;
    for (const sel of NEXT_BUTTON_CANDIDATES) {
      const el = page.locator(sel).first();
      if (await el.count().catch(() => 0)) {
        await el.click().catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) return false;
    await page.waitForTimeout(1200);
  }
  return true;
}

// Finds the element showing the month/year heading (e.g. "September 2026")
// and returns a snippet of its surrounding container's HTML, so we can see
// whatever nav buttons sit next to it.
async function captureNavHtml(page) {
  return page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const heading = all.find(el =>
      el.children.length === 0 &&
      /^[A-Z][a-z]+ \d{4}$/.test((el.textContent || '').trim())
    );
    if (!heading) return null;
    let container = heading.parentElement;
    for (let i = 0; i < 2 && container && container.parentElement; i++) {
      container = container.parentElement;
    }
    return container ? container.outerHTML.slice(0, 1800) : null;
  });
}

async function scrapeMuseum(browser, museum) {
  const url = `${BASE_URL}/${museum.id}`;
  const page = await browser.newPage();
  const result = {
    name: museum.name,
    id: museum.id,
    url,
    days: {},
    error: null,
  };

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

    const passType = museum.passType || 'digital';
    const toggleLabel = passType === 'physical'
      ? 'Show Physical Pass Availability'
      : 'Show Digital Pass Availability';
    const toggleBtn = page.getByText(toggleLabel, { exact: false });
    if (await toggleBtn.count().catch(() => 0)) {
      await toggleBtn.first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    await page.waitForFunction(() => {
      const text = document.body.innerText || '';
      return !text.includes('Determining Availability');
    }, { timeout: 30000 }).catch(() => {
      log(`  [warn] "Determining Availability" never cleared for ${museum.name}`);
    });
    await page.waitForTimeout(1500);

    const navHtmlBefore = DEBUG ? await captureNavHtml(page).catch(() => null) : null;

    let navClicked = null;
    if (NEXT_MONTHS > 0) {
      navClicked = await goToNextMonth(page, NEXT_MONTHS);
      await page.waitForFunction(() => {
        const text = document.body.innerText || '';
        return !text.includes('Determining Availability');
      }, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    const rawDays = await page.evaluate(() => {
      const dayEls = Array.from(document.querySelectorAll('[class*="day-20"]'))
        .filter(el => /\bday-\d{4}-\d{2}-\d{2}\b/.test(el.className));

      return dayEls.map(el => {
        const dateMatch = el.className.match(/day-(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : null;
        const isOtherMonth = /\bday-other-month\b/.test(el.className);

        const availEl = el.querySelector('[class*="s-lc-pass-"]');
        let state = 'unknown';
        if (isOtherMonth) {
          state = 'other-month';
        } else if (availEl) {
          if (availEl.classList.contains('s-lc-pass-available')) state = 'available';
          else if (availEl.classList.contains('s-lc-pass-unavailable')) state = 'unavailable';
          else if (availEl.classList.contains('s-lc-pass-closed')) state = 'closed';
        }

        const link = el.querySelector('a');
        return {
          date, state,
          isPast: /\bday-past\b/.test(el.className),
          hasLink: !!link,
          href: link ? link.getAttribute('href') : null,
          outerHTML: el.outerHTML.slice(0, 500),
        };
      }).filter(d => d.date);
    });

    if (DEBUG) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(path.join(DEBUG_DIR, `${museum.id}.json`), JSON.stringify(rawDays, null, 2));
      await page.screenshot({ path: path.join(DEBUG_DIR, `${museum.id}.png`), fullPage: true });

      const counts = rawDays.reduce((acc, d) => { acc[d.state] = (acc[d.state] || 0) + 1; return acc; }, {});
      const sampleFor = (state) => rawDays.find(d => d.state === state);
      const summaryChunk = [
        `## ${museum.name} (${museum.id})`,
        `- Days found: ${rawDays.length}${rawDays.length ? ` (${rawDays[0].date} to ${rawDays[rawDays.length - 1].date})` : ''}`,
        `- State counts: ${JSON.stringify(counts)}`,
        NEXT_MONTHS > 0 ? `- Next-month click attempted: ${navClicked === true ? 'a button was found and clicked' : 'NO MATCHING BUTTON FOUND (still showing original month)'}` : '- Next-month click not requested',
        '',
        '**Sample "available" cell:**', '~~~html', sampleFor('available') ? sampleFor('available').outerHTML : '(none found)', '~~~',
        '**Sample "unavailable" cell:**', '~~~html', sampleFor('unavailable') ? sampleFor('unavailable').outerHTML : '(none found)', '~~~',
        '**Sample "unknown" cell (if any):**', '~~~html', sampleFor('unknown') ? sampleFor('unknown').outerHTML : '(none found)', '~~~',
        '**Calendar header/nav area HTML (this is what we need to find the next-month button):**',
        '~~~html', navHtmlBefore || '(could not locate month heading)', '~~~',
        '',
      ].join('\n');
      fs.appendFileSync(SUMMARY_PATH, summaryChunk);
      log(`  [debug] wrote debug/${museum.id}.json, .png, and appended to SUMMARY.md`);
    }

    for (const cell of rawDays) {
      if (cell.state === 'other-month') continue; // not part of this museum's actual month
      const isAvailable = cell.state === 'available';
      result.days[cell.date] = {
        available: isAvailable,
        bookingUrl: isAvailable
          ? (cell.href ? new URL(cell.href, 'https://nrpl.libcal.com').toString() : url)
          : null,
      };
    }

    if (rawDays.length === 0) {
      result.error = 'No calendar day cells were found - markup may have changed. Run with DEBUG=1 to inspect.';
      log(`  [error] ${museum.name}: ${result.error}`);
    } else {
      const availCount = Object.values(result.days).filter(d => d.available).length;
      log(`  ${museum.name}: ${availCount} available day(s)`);
    }
  } catch (err) {
    result.error = err.message;
    log(`  [error] ${museum.name}: ${err.message}`);
  } finally {
    await page.close();
  }

  return result;
}

async function main() {
  if (DEBUG) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(SUMMARY_PATH, `# Debug summary\nGenerated ${new Date().toISOString()}\nNEXT_MONTHS=${NEXT_MONTHS}\n\n`);
  }

  log(`Starting scrape of ${museums.length} museums (headless=${HEADLESS}, debug=${DEBUG}${LIMIT ? `, limit=${LIMIT}` : ''}${NEXT_MONTHS ? `, next_months=${NEXT_MONTHS}` : ''})`);
  const browser = await chromium.launch({ headless: HEADLESS });

  const results = [];
  for (const museum of museums) {
    log(`Scraping ${museum.name}...`);
    results.push(await scrapeMuseum(browser, museum));
  }

  await browser.close();

  const output = { generatedAt: new Date().toISOString(), museums: results };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log(`Wrote results to ${OUTPUT_PATH}`);

  const failed = results.filter(r => r.error);
  if (failed.length) {
    log(`\n${failed.length} museum(s) had issues:`);
    failed.forEach(f => log(`  - ${f.name}: ${f.error}`));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
