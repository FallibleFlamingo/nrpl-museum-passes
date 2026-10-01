/**
 * NRPL Museum Pass Availability Scraper
 * ---------------------------------------
 * See README for background.
 *
 * BEING A GOOD CITIZEN ON NRPL's / SPRINGSHARE'S SERVERS
 *  - Manual trigger only - no automatic schedule (see the GitHub Actions
 *    workflow files, not this script).
 *  - REQUEST_DELAY_MS honors nrpl.libcal.com/robots.txt's explicit
 *    "User-agent: * / Crawl-delay: 10" directive - confirmed by fetching
 *    that file directly. We apply this delay before every separate
 *    request we make to their server: between museums, and also before
 *    any secondary request within a single museum's page (the Digital/
 *    Physical toggle, or the "next month" click used in debug mode).
 *  - Requests are made one museum at a time, never in parallel.
 *  - Exactly one page load per museum per run (plus one more if
 *    NEXT_MONTHS > 0) - nothing here polls or re-requests the server.
 *  - No automatic retries on failure - a museum that errors is just
 *    skipped and logged, rather than hammered again.
 *  - Identifies itself honestly via a custom User-Agent suffix, rather
 *    than pretending to be an anonymous ordinary browser.
 *  - Every network/page operation has an explicit timeout, and a hard
 *    overall watchdog (HARD_TIMEOUT_MS) force-exits the whole script if
 *    something unexpected keeps it alive far longer than it should ever
 *    take - a second line of defense on top of the GitHub Actions
 *    workflow's own timeout-minutes setting. Both ceilings are set with
 *    real margin above the realistic worst case (~30 min for all 18
 *    museums at a 10s crawl-delay), so a normal run never gets cut off.
 *
 * HOW WE DETECT AVAILABILITY (confirmed against the real site)
 * Each day is rendered as:
 *   <div class="day day-Wed day-2026-10-14">
 *     <div class="day-number">
 *       <a href="/passes/.../physical?date=2026-10-14&..."
 *          class="s-lc-pass-availability s-lc-pass-available">14</a>
 *     </div>
 *   </div>
 * for an available day, versus a plain (non-link) <span class="...
 * s-lc-pass-unavailable"> or "...s-lc-pass-closed"> for days that aren't
 * bookable. The exact date is embedded in the outer div's class name. The
 * <a href> on available days is a real, date-specific booking link, which
 * we capture directly.
 *
 * KNOWN LIMITATION (unverified): museums offering both Digital and
 * Physical passes (confirmed so far: The Frick Collection) show a toggle
 * button. We click the "Digital" one by default. This hasn't yet been
 * verified against a debug run that actually included the Frick - run
 * the debug workflow with museum_limit set high enough to include it
 * before fully trusting its data.
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

const REQUEST_DELAY_MS = 10000;        // honors nrpl.libcal.com's robots.txt: "User-agent: * / Crawl-delay: 10"
const PAGE_DEFAULT_TIMEOUT_MS = 15000; // floor for any Playwright action without its own explicit timeout
const HARD_TIMEOUT_MS = 40 * 60 * 1000; // absolute ceiling for the whole run - comfortably above the ~30 min realistic worst case

// Identifies this tool honestly to whatever server we're talking to,
// rather than pretending to be an anonymous ordinary browser. If NRPL or
// Springshare ever notice unusual traffic, this makes it easy to tell it
// apart from something malicious - and easy to block via robots.txt if
// they'd rather this not run at all.
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

// Hard watchdog: if the whole script is somehow still running after
// HARD_TIMEOUT_MS (which should never happen given the per-step timeouts
// below), force-exit rather than let it run indefinitely.
const watchdog = setTimeout(() => {
  console.error(`[fatal] Hard timeout of ${HARD_TIMEOUT_MS / 60000} minutes reached - aborting.`);
  process.exit(1);
}, HARD_TIMEOUT_MS);
watchdog.unref(); // doesn't keep the process alive on its own if everything else finishes cleanly

const NEXT_BUTTON_CANDIDATES = [
  '#s-lc-date-next',
  '.fc-next-button',
];

async function goToNextMonth(page, times) {
  for (let i = 0; i < times; i++) {
    // This click triggers a fresh request to the server for the next
    // month's data - honor the crawl-delay before firing it off, same as
    // we do between museums.
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
    await page.waitForTimeout(1200);
  }
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

async function scrapeMuseum(context, museum) {
  const url = `${BASE_URL}/${museum.id}`;
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_DEFAULT_TIMEOUT_MS); // floor for any action below that doesn't set its own timeout

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
      // This toggle may trigger its own request to refresh availability
      // for the selected pass type - honor the crawl-delay before it too.
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
        '**Calendar header/nav area HTML:**',
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
    // Deliberately NOT retrying here - a museum that errors is skipped and
    // logged, so a flaky page never turns into repeated hammering.
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
  const context = await browser.newContext({ userAgent: USER_AGENT });

  const results = [];
  for (let i = 0; i < museums.length; i++) {
    const museum = museums[i];
    log(`Scraping ${museum.name}...`);
    results.push(await scrapeMuseum(context, museum));

    // Polite pause before the next museum - skip after the last one.
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
