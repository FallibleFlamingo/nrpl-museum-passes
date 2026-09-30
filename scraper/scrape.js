/**
 * NRPL Museum Pass Availability Scraper
 * ---------------------------------------
 * Visits every museum's LibCal "passes" page, waits for the JS-rendered
 * calendar to load, and records which days are available vs. not.
 *
 * HOW WE DETECT AVAILABILITY (confirmed from a real debug run)
 * Each day is rendered as:
 *   <div class="day day-Tue day-2026-09-01 day-past">
 *     <div class="day-number">
 *       <span class="s-lc-pass-availability s-lc-pass-unavailable">1</span>
 *     </div>
 *   </div>
 * The exact date is embedded right in the outer div's class name
 * (day-YYYY-MM-DD) - so we read dates from there directly instead of
 * parsing a month heading. The inner span's second class tells us the
 * state: s-lc-pass-available / s-lc-pass-unavailable / s-lc-pass-closed
 * (closed = e.g. a past date, or a day the library itself is closed).
 * Only "available" counts as bookable.
 *
 * DEBUG MODE (DEBUG=1)
 * Saves, per museum, into scraper/debug/:
 *   - <id>.png    a full-page screenshot
 *   - <id>.json   every calendar cell found, with its raw HTML
 * And writes ONE combined file, scraper/debug/SUMMARY.md, with a compact
 * per-museum readout plus a sample of each state's HTML found. Small
 * enough to paste back into a chat with Claude for troubleshooting.
 *
 * ENV VARS
 *   HEADLESS=0        show the browser window (local use only, not CI)
 *   DEBUG=1           save screenshots + HTML dumps described above
 *   MUSEUM_LIMIT=3    only scrape the first N museums (faster iteration)
 *   NEXT_MONTHS=1     click "next month" this many times before reading
 *                     the calendar (e.g. 1 = next month instead of current)
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

// Candidate selectors for a "go to next month" control. We try each in
// turn since we haven't been able to directly inspect this part of the
// markup yet - if none match, we log a warning rather than failing.
const NEXT_BUTTON_CANDIDATES = [
  'a[title*="Next" i]',
  'button[title*="Next" i]',
  'a[aria-label*="Next" i]',
  'button[aria-label*="Next" i]',
  '.s-lc-cal-next',
  '.cal-next',
  'a.next',
  'button.next',
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
    if (!clicked) {
      log('  [warn] Could not find a "next month" button - NEXT_MONTHS may not have worked. Check SUMMARY.md monthLabel / dates found.');
      return;
    }
    await page.waitForTimeout(1200);
  }
}

async function scrapeMuseum(browser, museum) {
  const url = `${BASE_URL}/${museum.id}`;
  const page = await browser.newPage();
  const result = {
    name: museum.name,
    id: museum.id,
    url,
    days: {}, // "YYYY-MM-DD" -> { available: bool, bookingUrl: string }
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

    if (NEXT_MONTHS > 0) {
      await goToNextMonth(page, NEXT_MONTHS);
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

        const availEl = el.querySelector('[class*="s-lc-pass-"]');
        let state = 'unknown';
        let stateClass = availEl ? availEl.className : null;
        if (availEl) {
          if (availEl.classList.contains('s-lc-pass-available')) state = 'available';
          else if (availEl.classList.contains('s-lc-pass-unavailable')) state = 'unavailable';
          else if (availEl.classList.contains('s-lc-pass-closed')) state = 'closed';
        }

        const link = el.querySelector('a');

        return {
          date,
          state,
          stateClass,
          isPast: /\bday-past\b/.test(el.className),
          hasLink: !!link,
          href: link ? link.getAttribute('href') : null,
          outerHTML: el.outerHTML.slice(0, 500),
        };
      }).filter(d => d.date);
    });

    if (DEBUG) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DEBUG_DIR, `${museum.id}.json`),
        JSON.stringify(rawDays, null, 2)
      );
      await page.screenshot({
        path: path.join(DEBUG_DIR, `${museum.id}.png`),
        fullPage: true,
      });

      const counts = rawDays.reduce((acc, d) => {
        acc[d.state] = (acc[d.state] || 0) + 1;
        return acc;
      }, {});
      const sampleFor = (state) => rawDays.find(d => d.state === state);
      const summaryChunk = [
        `## ${museum.name} (${museum.id})`,
        `- Days found: ${rawDays.length}${rawDays.length ? ` (${rawDays[0].date} to ${rawDays[rawDays.length - 1].date})` : ''}`,
        `- State counts: ${JSON.stringify(counts)}`,
        '',
        '**Sample "available" cell:**',
        '```html',
        sampleFor('available') ? sampleFor('available').outerHTML : '(none found)',
        '```',
        '**Sample "unavailable" cell:**',
        '```html',
        sampleFor('unavailable') ? sampleFor('unavailable').outerHTML : '(none found)',
        '```',
        '**Sample "unknown" cell (if any - means our class detection missed something):**',
        '```html',
        sampleFor('unknown') ? sampleFor('unknown').outerHTML : '(none found)',
        '```',
        '',
      ].join('\n');
      fs.appendFileSync(SUMMARY_PATH, summaryChunk);
      log(`  [debug] wrote debug/${museum.id}.json, .png, and appended to SUMMARY.md`);
    }

    for (const cell of rawDays) {
      result.days[cell.date] = {
        available: cell.state === 'available',
        bookingUrl: cell.state === 'available' ? url : null,
      };
    }

    if (rawDays.length === 0) {
      result.error = 'No calendar day cells were found - markup may have changed. Run with DEBUG=1 to inspect.';
      log(`  [error] ${museum.name}: ${result.error}`);
    } else {
      const availCount = rawDays.filter(d => d.state === 'available').length;
      log(`  ${museum.name}: ${availCount} available day(s) out of ${rawDays.length} found`);
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
    const result = await scrapeMuseum(browser, museum);
    results.push(result);
  }

  await browser.close();

  const output = {
    generatedAt: new Date().toISOString(),
    museums: results,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log(`Wrote results to ${OUTPUT_PATH}`);

  const failed = results.filter(r => r.error);
  if (failed.length) {
    log(`\n${failed.length} museum(s) had issues:`);
    failed.forEach(f => log(`  - ${f.name}: ${f.error}`));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
