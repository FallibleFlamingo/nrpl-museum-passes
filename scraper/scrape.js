/**
 * NRPL Museum Pass Availability Scraper
 * ---------------------------------------
 * Visits every museum's LibCal "passes" page, waits for the JS-rendered
 * calendar to load, and records which days of the current month are
 * available (clickable) vs. unavailable.
 *
 * WHY A HEADLESS BROWSER?
 * The calendar on nrpl.libcal.com is drawn by JavaScript after the page
 * loads - it isn't present in the raw HTML. Playwright drives a real
 * (headless) browser so we see the page the same way a visitor would.
 *
 * HOW WE DETECT AVAILABILITY
 * Available days are clickable links; unavailable days are not. Rather
 * than relying on brittle CSS class names (which Springshare could rename
 * any time), we check DOM structure: is a day cell a clickable element
 * (<a>, or something containing a link/button) or inert text?
 *
 * DEBUG MODE (DEBUG=1)
 * Saves, per museum, into scraper/debug/:
 *   - <id>.png            a full-page screenshot
 *   - <id>.json           every calendar cell found, with its raw HTML
 * And writes ONE combined file, scraper/debug/SUMMARY.md, with a compact
 * per-museum readout plus one sample "available" and one sample
 * "unavailable" cell's HTML. That single file is small enough to paste
 * back into a chat with Claude for troubleshooting, instead of digging
 * through 18 separate files.
 *
 * ENV VARS
 *   HEADLESS=0        show the browser window (only useful locally, not in CI)
 *   DEBUG=1           save screenshots + HTML dumps described above
 *   MUSEUM_LIMIT=3    only scrape the first N museums (faster iteration)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let museums = require('./museums.json');

const BASE_URL = 'https://nrpl.libcal.com/passes';
const HEADLESS = process.env.HEADLESS !== '0';
const DEBUG = process.env.DEBUG === '1';
const LIMIT = process.env.MUSEUM_LIMIT ? parseInt(process.env.MUSEUM_LIMIT, 10) : null;
const OUTPUT_PATH = path.join(__dirname, '..', 'docs', 'data', 'availability.json');
const DEBUG_DIR = path.join(__dirname, 'debug');
const SUMMARY_PATH = path.join(DEBUG_DIR, 'SUMMARY.md');

if (LIMIT) museums = museums.slice(0, LIMIT);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function scrapeMuseum(browser, museum) {
  const url = `${BASE_URL}/${museum.id}`;
  const page = await browser.newPage();
  const result = {
    name: museum.name,
    id: museum.id,
    url,
    monthLabel: null,
    days: {}, // "YYYY-MM-DD" -> { available: bool, bookingUrl: string }
    error: null,
  };

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

    // If a museum offers both Digital and Physical passes, LibCal shows
    // toggle buttons. We prefer "Digital" since that's what most patrons
    // want; edit museum.passType in museums.json to "physical" to switch
    // an individual museum.
    const passType = museum.passType || 'digital';
    const toggleLabel = passType === 'physical'
      ? 'Show Physical Pass Availability'
      : 'Show Digital Pass Availability';
    const toggleBtn = page.getByText(toggleLabel, { exact: false });
    if (await toggleBtn.count().catch(() => 0)) {
      await toggleBtn.first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    // Wait for the "Determining Availability" placeholder to disappear
    // and for actual calendar day cells to show up.
    await page.waitForFunction(() => {
      const text = document.body.innerText || '';
      return !text.includes('Determining Availability');
    }, { timeout: 30000 }).catch(() => {
      log(`  [warn] "Determining Availability" never cleared for ${museum.name}`);
    });

    await page.waitForTimeout(1500);

    result.monthLabel = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('h2, h3, .calendar-header, [class*="month"]'))
        .map(el => el.textContent.trim())
        .find(t => /^[A-Z][a-z]+ \d{4}$/.test(t));
      return heading || null;
    });

    const rawDays = await page.evaluate(() => {
      const containers = Array.from(document.querySelectorAll(
        'table, [class*="calendar"], [id*="calendar"]'
      ));

      const seen = new Set();
      const cells = [];
      const candidateSelector = 'td, [role="gridcell"], .day, [class*="day"]';
      const pool = containers.length
        ? containers.flatMap(c => Array.from(c.querySelectorAll(candidateSelector)))
        : Array.from(document.querySelectorAll(candidateSelector));

      for (const el of pool) {
        const text = (el.textContent || '').trim();
        if (!/^\d{1,2}$/.test(text)) continue;

        const key = el.outerHTML.slice(0, 40) + text + el.getBoundingClientRect().top;
        if (seen.has(key)) continue;
        seen.add(key);

        const link = el.querySelector('a') || (el.tagName === 'A' ? el : null);
        const clickableDescendant = el.querySelector('a, button, [role="button"]');
        const isClickable = !!(link || clickableDescendant);

        const dateAttr =
          el.getAttribute('data-date') ||
          el.getAttribute('data-day') ||
          (link && link.getAttribute('data-date')) ||
          (link && link.getAttribute('href')) ||
          null;

        cells.push({
          dayNumber: parseInt(text, 10),
          isClickable,
          dateAttr,
          href: link ? link.getAttribute('href') : null,
          classes: el.className,
          outerHTML: el.outerHTML.slice(0, 500),
        });
      }
      return cells;
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

      const availableSample = rawDays.find(c => c.isClickable);
      const unavailableSample = rawDays.find(c => !c.isClickable);
      const summaryChunk = [
        `## ${museum.name} (${museum.id})`,
        `- Month heading detected: ${result.monthLabel || '(none found)'}`,
        `- Calendar cells found: ${rawDays.length}`,
        `- Marked available: ${rawDays.filter(c => c.isClickable).length}`,
        '',
        '**Sample "available" cell HTML:**',
        '```html',
        availableSample ? availableSample.outerHTML : '(none found)',
        '```',
        '**Sample "unavailable" cell HTML:**',
        '```html',
        unavailableSample ? unavailableSample.outerHTML : '(none found)',
        '```',
        '',
      ].join('\n');
      fs.appendFileSync(SUMMARY_PATH, summaryChunk);

      log(`  [debug] wrote debug/${museum.id}.json, .png, and appended to SUMMARY.md`);
    }

    const now = new Date();
    let year = now.getFullYear();
    let monthIndex = now.getMonth();
    if (result.monthLabel) {
      const parsed = new Date(`1 ${result.monthLabel}`);
      if (!isNaN(parsed)) {
        year = parsed.getFullYear();
        monthIndex = parsed.getMonth();
      }
    }

    for (const cell of rawDays) {
      const dateObj = new Date(year, monthIndex, cell.dayNumber);
      const iso = dateObj.toISOString().slice(0, 10);
      const existing = result.days[iso];
      result.days[iso] = {
        available: existing ? existing.available || cell.isClickable : cell.isClickable,
        bookingUrl: cell.isClickable ? url : null,
      };
    }

    if (Object.keys(result.days).length === 0) {
      result.error = 'No calendar day cells were found - selectors likely need adjusting. Run with DEBUG=1 to inspect.';
      log(`  [error] ${museum.name}: ${result.error}`);
    } else {
      const availCount = Object.values(result.days).filter(d => d.available).length;
      log(`  ${museum.name}: ${availCount} available day(s) out of ${Object.keys(result.days).length} found`);
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
    fs.writeFileSync(SUMMARY_PATH, `# Debug summary\nGenerated ${new Date().toISOString()}\n\n`);
  }

  log(`Starting scrape of ${museums.length} museums (headless=${HEADLESS}, debug=${DEBUG}${LIMIT ? `, limit=${LIMIT}` : ''})`);
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
