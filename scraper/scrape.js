/**
 * NRPL Museum Pass Availability Scraper
 * ---------------------------------------
 * See README for background.
 *
 * BEING A GOOD CITIZEN ON NRPL's / SPRINGSHARE'S SERVERS
 *  - Manual trigger only - no automatic schedule.
 *  - REQUEST_DELAY_MS honors nrpl.libcal.com/robots.txt "Crawl-delay: 10".
 *  - Requests are made one museum at a time, never in parallel.
 *  - No automatic retries on failure.
 *  - Identifies itself honestly via a custom User-Agent suffix.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let museums = require('./museums.json');

const BASE_URL = 'https://nrpl.libcal.com/passes';
const HEADLESS = process.env.HEADLESS !== '0';
const DEBUG = process.env.DEBUG === '1';
const LIMIT = process.env.MUSEUM_LIMIT ? parseInt(process.env.MUSEUM_LIMIT, 10) : null;
const MONTHS_TO_SCRAPE = process.env.MONTHS_TO_SCRAPE ? parseInt(process.env.MONTHS_TO_SCRAPE, 10) : 3;

const OUTPUT_PATH = path.join(__dirname, '..', 'docs', 'data', 'availability.json');
const DEBUG_DIR = path.join(__dirname, 'debug');
const SUMMARY_PATH = path.join(DEBUG_DIR, 'SUMMARY.md');

const REQUEST_DELAY_MS = 10000;         // honors nrpl.libcal.com's robots.txt
const PAGE_DEFAULT_TIMEOUT_MS = 15000; // floor for Playwright actions
const HARD_TIMEOUT_MS = 60 * 60 * 1000; // absolute watchdog ceiling (1 hour)

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/129.0.0.0 Safari/537.36 NRPL-MuseumPassChecker/1.0 (+personal, non-commercial, manual-trigger-only tool)';

if (LIMIT) museums = museums.slice(0, LIMIT);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const watchdog = setTimeout(() => {
  console.error(`[fatal] Hard timeout of ${HARD_TIMEOUT_MS / 60000} minutes reached - aborting.`);
  process.exit(1);
}, HARD_TIMEOUT_MS);
watchdog.unref();

const NEXT_BUTTON_CANDIDATES = [
  '#s-lc-date-next',
  '.fc-next-button',
];

async function clickNextMonth(page) {
  await sleep(REQUEST_DELAY_MS);

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

  await page.waitForFunction(() => {
    const text = document.body.innerText || '';
    return !text.includes('Determining Availability');
  }, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  return true;
}

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

async function extractDaysFromPage(page) {
  return page.evaluate(() => {
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
}

async function scrapeMuseum(context, museum) {
  const url = `${BASE_URL}/${museum.id}`;
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_DEFAULT_TIMEOUT_MS);

  const result = {
    name: museum.name,
    id: museum.id,
    theme: museum.theme || 'General',
    themes: museum.themes || (museum.theme ? [museum.theme] : ['General']),
    location: museum.location || 'New York City',
    url,
    days: {},
    error: null,
  };

  const allRawDays = [];

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

    const passType = museum.passType || 'digital';
    const toggleLabel = passType === 'physical'
      ? 'Show Physical Pass Availability'
      : 'Show Digital Pass Availability';
    const toggleBtn = page.getByText(toggleLabel, { exact: false });
    if (await toggleBtn.count().catch(() => 0)) {
      await sleep(REQUEST_DELAY_MS);
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

    for (let m = 0; m < MONTHS_TO_SCRAPE; m++) {
      if (m > 0) {
        const nextSuccess = await clickNextMonth(page);
        if (!nextSuccess) {
          log(`  [warn] ${museum.name}: Could not click next month button on month index ${m}`);
          break;
        }
      }

      const rawDays = await extractDaysFromPage(page);
      allRawDays.push(...rawDays);

      for (const cell of rawDays) {
        if (cell.state === 'other-month') continue;
        const isAvailable = cell.state === 'available';
        result.days[cell.date] = {
          available: isAvailable,
          bookingUrl: isAvailable
            ? (cell.href ? new URL(cell.href, 'https://nrpl.libcal.com').toString() : url)
            : null,
        };
      }
    }

    if (DEBUG) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(path.join(DEBUG_DIR, `${museum.id}.json`), JSON.stringify(allRawDays, null, 2));
      await page.screenshot({ path: path.join(DEBUG_DIR, `${museum.id}.png`), fullPage: true });

      const navHtml = await captureNavHtml(page).catch(() => null);
      const counts = allRawDays.reduce((acc, d) => { acc[d.state] = (acc[d.state] || 0) + 1; return acc; }, {});
      const sampleFor = (state) => allRawDays.find(d => d.state === state);
      const summaryChunk = [
        `## ${museum.name} (${museum.id})`,
        `- Days found across ${MONTHS_TO_SCRAPE} month(s): ${allRawDays.length}`,
        `- State counts: ${JSON.stringify(counts)}`,
        '**Sample "available" cell:**', '~~~html', sampleFor('available') ? sampleFor('available').outerHTML : '(none found)', '~~~',
        '**Calendar header/nav area HTML:**', '~~~html', navHtml || '(could not locate month heading)', '~~~',
        '',
      ].join('\n');
      fs.appendFileSync(SUMMARY_PATH, summaryChunk);
    }

    const availCount = Object.values(result.days).filter(d => d.available).length;
    log(`  ${museum.name}: ${availCount} total available day(s) across ${MONTHS_TO_SCRAPE} month(s)`);

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
    fs.writeFileSync(SUMMARY_PATH, `# Debug summary\nGenerated ${new Date().toISOString()}\nMONTHS_TO_SCRAPE=${MONTHS_TO_SCRAPE}\n\n`);
  }

  log(`Starting scrape of ${museums.length} museums across ${MONTHS_TO_SCRAPE} month(s) (headless=${HEADLESS}, debug=${DEBUG}${LIMIT ? `, limit=${LIMIT}` : ''})`);
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ userAgent: USER_AGENT });

  const results = [];
  for (let i = 0; i < museums.length; i++) {
    const museum = museums[i];
    log(`Scraping ${museum.name}...`);
    results.push(await scrapeMuseum(context, museum));

    if (i < museums.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  await context.close();
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

  clearTimeout(watchdog);
}

main().catch(err => { console.error(err); process.exit(1); });
