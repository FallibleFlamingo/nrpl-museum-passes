# NRPL Museum Pass Availability

Everything below can be done through **github.com in your browser** — no
software to install, no terminal.

## 1. Create the repository

- Go to [github.com/new](https://github.com/new) (sign up free if you
  haven't). Name it `nrpl-museum-passes`. Keep it **Public**. Create it.
- On the new (empty) repo page, click **uploading an existing file**.
- Drag the *entire contents* of this unzipped folder into the upload box
  (drag the `scraper` folder, `docs` folder, `.github` folder,
  `package.json`, and this `README.md` all together — your browser will
  preserve the folder structure). Commit the upload.

## 2. Run the DEBUG workflow first — don't skip this

This is the troubleshooting step. It checks 3 museums, takes a couple of
minutes, and doesn't touch your real data.

- In your repo, click the **Actions** tab.
- GitHub will ask you to confirm workflows are enabled — click to enable.
- In the left sidebar, click **"Debug scrape (manual)"**.
- Click the **Run workflow** button (top right of that page), leave
  "museum_limit" as `3`, click the green **Run workflow** button to confirm.
- Wait ~2-3 minutes, refresh, click into the run once it shows a green
  checkmark (or red X — that's fine too, still useful).
- Scroll to the bottom of that run's summary page to **Artifacts**, and
  download **debug-report**. Unzip it.
- Inside, open **`SUMMARY.md`** in any text editor (or drag it into a chat
  with Claude). It contains, for each of the 3 test museums: how many
  calendar days were found, how many were marked "available", and a sample
  of the raw HTML for one available day and one unavailable day.

**Bring `SUMMARY.md` back to this conversation** (paste its contents, or
upload the file) — that's exactly the information needed to check whether
the scraper is correctly telling green (bookable) days apart from brown
(unbookable) ones, and to fix `scraper/scrape.js` if it isn't. The debug
report also includes a full-page screenshot per museum (`<id>.png`) — those
are useful to compare side-by-side with the real site too.

Repeat this step (edit `scraper/scrape.js` if changes are needed, re-run
the debug workflow) until `SUMMARY.md` looks right — the counts of
available days should visibly match what you see when you open a museum's
real page yourself.

## 3. Turn on GitHub Pages

Once the debug output looks correct:

- **Settings → Pages**. Source: "Deploy from a branch". Branch: `main`,
  folder: **`/docs`**. Save.
- GitHub gives you a URL like `https://yourusername.github.io/nrpl-museum-passes/`.

## 4. Run the real scraper

- **Actions → "Scrape museum pass availability" → Run workflow** (this one
  scrapes all 18 museums and commits the results).
- Once it finishes, visit your Pages URL from step 3 — you should see the
  day-by-day dashboard.
- After this first manual run, it repeats automatically every 3 hours on
  its own. Change the `cron` line in `.github/workflows/scrape.yml` to
  adjust the frequency (edit that file directly on github.com — pencil
  icon on the file page).

## Notes & limitations

- **Physical vs. Digital passes**: a few museums (like the Frick) offer
  both. The scraper defaults to "Digital" per museum. Change an individual
  museum to physical by adding `"passType": "physical"` to its entry in
  `scraper/museums.json`.
- **Booking links** take you to that museum's pass page with the calendar
  loaded — you still click the specific date yourself from there, since
  LibCal's booking flow is a multi-step form rather than one URL per date.
- **Current month only**, matching what you asked for originally.
