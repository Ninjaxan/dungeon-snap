#!/usr/bin/env node
/**
 * Dungeon Snap play-agent.
 *
 * Drives the companion site at http://localhost:8000 through every smoke
 * action (Get Account → Get Balance → Show Account → Sign ADR-036 →
 * Send 0.1 DGN). Screenshots each step, auto-clicks the MetaMask Flask
 * popups, and (with --review) sends the screenshot reel to Claude
 * Sonnet 4.6 for visual bug-flagging.
 *
 * Modeled on ~/kosmic-dungeon/tools/play-game-agent.cjs — same outputs
 * shape, same vision pattern, scoped to Snap surfaces.
 *
 * USAGE
 *   node tools/play-snap-agent.cjs                  # headed, no vision review
 *   node tools/play-snap-agent.cjs --review         # run Claude vision pass at end
 *   node tools/play-snap-agent.cjs --headless       # CI mode (popups still auto-clicked)
 *
 * ONE-TIME SETUP
 *   1. Download MetaMask Flask Chrome zip from
 *      https://github.com/MetaMask/metamask-extension/releases
 *      (file name: metamask-flask-chrome-<version>-flask.0.zip)
 *   2. Extract to ~/dungeon-snap/.flask-extension/  (manifest.json must be at the root)
 *   3. Start the local snap server (separate terminal):
 *      yarn workspace dungeon-snap serve
 *   4. Start the companion site (separate terminal):
 *      yarn workspace site start
 *   5. Run this script. On the first run, you'll need to onboard Flask
 *      (set password + import or create a seed). The profile is saved to
 *      ~/.dungeon-snap-flask-profile/ and reused on subsequent runs.
 *
 * REQUIRES
 *   - ANTHROPIC_API_KEY in env (sourced from ~/.env) for --review mode
 *   - puppeteer + @anthropic-ai/sdk (already added as repo devDeps)
 */
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const puppeteer = require("puppeteer");

// ── env ────────────────────────────────────────────────────────────────
(function loadDotenv() {
  const envPath = path.join(os.homedir(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

// ── CLI ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const HEADLESS = args.includes("--headless");
const REVIEW = args.includes("--review");
const SITE_URL = grabArg("--site", "http://localhost:8000");
const SRP = grabArg(
  "--srp",
  "test test test test test test test test test test test ball", // snaps-jest DEFAULT_SRP — funded dungeon1navfpzthnwes9g5xmgpwykdayukjavl8w6pehe
);
const PASSWORD = grabArg("--password", "DungeonSnap1!");
function grabArg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

// ── paths ──────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, "..");
const FLASK_DIR = path.join(ROOT, ".flask-extension");
const PROFILE_DIR = path.join(os.homedir(), ".dungeon-snap-flask-profile");
const REPORTS_ROOT = path.join(ROOT, "ai-reports", "play-session");
const SESSION_DIR = path.join(REPORTS_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
const SHOTS = path.join(SESSION_DIR, "screenshots");

// ── helpers ────────────────────────────────────────────────────────────
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}`;
  console.log(line);
  fs.appendFileSync(path.join(SESSION_DIR, "session.log"), line + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureFlask() {
  if (fs.existsSync(path.join(FLASK_DIR, "manifest.json"))) return;
  console.error("");
  console.error("  ✖ MetaMask Flask extension not found at:");
  console.error(`    ${FLASK_DIR}`);
  console.error("");
  console.error("  Setup:");
  console.error("    1. Download from https://github.com/MetaMask/metamask-extension/releases");
  console.error("       (look for metamask-flask-chrome-<version>-flask.0.zip)");
  console.error(`    2. Extract so that ${FLASK_DIR}/manifest.json exists`);
  console.error("    3. Re-run this script.");
  console.error("");
  process.exit(2);
}

async function clickAny(page, selectors, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return sel;
      }
    }
    await sleep(150);
  }
  return null;
}

// MetaMask popup auto-clicker. Approves the primary action on any
// notification popup spawned by Flask while we drive the site.
function attachPopupHandler(browser) {
  browser.on("targetcreated", async (target) => {
    if (target.type() !== "page") return;
    const url = target.url();
    if (!/^chrome-extension:\/\/[^/]+\/notification\.html/.test(url)) return;
    log("[popup] detected:", url);
    // MetaMask popups can rapidly navigate through multiple internal views
    // (snap-install → permissions → connect → confirm). Each view shows a
    // primary CTA. Click any matching CTA up to N times until the popup
    // closes or we've exhausted retries.
    const start = Date.now();
    let clicks = 0;
    while (Date.now() - start < 45_000 && clicks < 10) {
      const page = await target.page().catch(() => null);
      if (!page || page.isClosed()) {
        log("[popup] page closed after", clicks, "clicks");
        return;
      }
      await sleep(700);
      const screenshotPath = path.join(SHOTS, `popup-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      // Scroll the popup via real input events (mouse wheel + End key) so any
      // gated-by-scroll modal (Third-party Software Notice etc.) enables its
      // primary action. LavaMoat blocks direct `el.scrollTop` writes via
      // evaluate; mouse wheel goes through native input dispatching.
      try {
        await page.mouse.move(640, 350);
        for (let s = 0; s < 6; s++) {
          await page.mouse.wheel({ deltaY: 400 });
          await sleep(80);
        }
        await page.keyboard.press("End").catch(() => {});
        await sleep(300);
      } catch {}

      // MetaMask unlock screen — fill password before any approval popup
      const unlockInput = await page.$('[data-testid="unlock-password"], input[type="password"]');
      if (unlockInput) {
        try {
          await page.type(
            '[data-testid="unlock-password"], input[type="password"]',
            PASSWORD,
            { delay: 50 },
          );
          await sleep(300);
          const unlockClicked = await clickAny(
            page,
            ['[data-testid="unlock-submit"]', 'button[type="submit"]'],
            3000,
          );
          if (!unlockClicked) {
            await clickByText(page, [/^unlock$/i], 2000);
          }
          log(`[popup] entered password + clicked Unlock (try ${clicks + 1})`);
          clicks++;
          await sleep(1500);
          continue;
        } catch (err) {
          log("[popup] unlock attempt failed:", err.message);
        }
      }
      // Try modal-priority text matches FIRST — "Accept" on a modal (rendered
      // above the underlying popup) must win over the underlying snap-install
      // Connect/Next testid, otherwise we click the disabled underlying button
      // and never dismiss the modal.
      const modalClicked = await clickByText(
        page,
        [/^accept$/i, /^i accept$/i],
        1500,
      );
      if (modalClicked) {
        log(`[popup] modal accept clicked (try ${clicks + 1})`);
        clicks++;
        await sleep(900);
        continue;
      }

      // Snap-install "Proceed with caution" modal: an unchecked checkbox
      // ("Install Dungeon") gates the modal's Confirm button. Check it then
      // click Confirm.
      const checkboxes = await page.$$('input[type="checkbox"]');
      let checkedSomething = false;
      for (const cb of checkboxes) {
        const isUnchecked = await cb
          .evaluate((el) => !el.checked)
          .catch(() => false);
        if (isUnchecked) {
          await cb.click().catch(() => {});
          checkedSomething = true;
        }
      }
      if (checkedSomething) {
        log(`[popup] checked checkbox(es) (try ${clicks + 1})`);
        await sleep(400);
      }

      const clicked = await clickAny(
        page,
        [
          '[data-testid="confirm-btn"]',
          '[data-testid="confirmation-submit-button"]',
          '[data-testid="page-container-footer-next"]',
          '[data-testid="snap-install-warning-modal-confirm"]',
          '[data-testid="snap-install-scroll"]',
          '[data-testid="snap-update-scroll"]',
          'button.btn-primary',
        ],
        2000,
      );
      if (clicked) {
        log(`[popup] clicked ${clicked} (try ${clicks + 1})`);
        clicks++;
        await sleep(700);
        continue;
      }
      // No testid match — try text-based fallback
      const textClicked = await clickByText(
        page,
        [/^connect$/i, /^next$/i, /^approve$/i, /^confirm$/i, /^install$/i, /^got it$/i, /^send$/i],
        2000,
      );
      if (textClicked) {
        log(`[popup] text-clicked (try ${clicks + 1})`);
        clicks++;
        await sleep(700);
        continue;
      }
      break;
    }
    log("[popup] handler finished, total clicks:", clicks);
  });
}

async function snap(page, label, opts = {}) {
  const file = path.join(SHOTS, `${label}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage !== false });
  log("[shot]", label);
  return file;
}

// Click a button by visible text content. More robust than testid selectors
// for surfaces whose testids change between MetaMask releases.
//
// Strategy: iterate all clickable-shaped elements via puppeteer $$, evaluate
// each one's text + visibility separately. This avoids LavaMoat-scuttled
// globals and lets us pick the correct element (the visible one) even if
// duplicates exist.
async function clickByText(page, patterns, timeout = 6000) {
  const deadline = Date.now() + timeout;
  const regexes = patterns.map((p) =>
    typeof p === "string" ? new RegExp(`^\\s*${p}\\s*$`, "i") : p,
  );
  // Priority order — leaf clickables first, generic containers last. This
  // prevents matching a parent DIV whose textContent contains a child
  // button's text.
  const selectorTiers = [
    "button",
    '[role="button"]',
    'a[role="button"]',
    "a",
    "[data-testid]",
  ];
  while (Date.now() < deadline) {
    for (const sel of selectorTiers) {
      const handles = await page.$$(sel);
      for (const h of handles) {
        const text = await h
          .evaluate((el) => (el.innerText || el.textContent || "").trim())
          .catch(() => "");
        // Skip generic containers — leaf clickables are typically <120 chars.
        if (text.length > 120) continue;
        const visible = await h
          .evaluate((el) => {
            const r = el.getBoundingClientRect();
            const style = el.ownerDocument.defaultView.getComputedStyle(el);
            return (
              r.width > 0 &&
              r.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          })
          .catch(() => false);
        if (!visible) continue;
        for (const r of regexes) {
          if (r.test(text)) {
            await h.click().catch(() => {});
            log(`[click] matched "${text.slice(0, 60)}" via ${r} (selector ${sel})`);
            return true;
          }
        }
      }
    }
    await sleep(250);
  }
  return false;
}

// Debug helper — dump visible clickable elements + their data-testids.
async function dumpClickables(page, label) {
  const handles = await page.$$('button, [role="button"], a, [data-testid]');
  const lines = [];
  for (const h of handles) {
    const info = await h
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return {
          tag: el.tagName,
          testid: el.getAttribute("data-testid"),
          text: ((el.innerText || el.textContent || "").trim()).slice(0, 80),
        };
      })
      .catch(() => null);
    if (info) lines.push(info);
  }
  log(`[dump:${label}]`, JSON.stringify(lines.slice(0, 30)));
}

// Wait for the Flask welcome tab to appear after Chrome launch.
// Returns the page object if found, null if profile is already onboarded.
async function findFlaskWelcome(browser, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = browser.targets();
    for (const t of targets) {
      const u = t.url();
      if (
        t.type() === "page" &&
        /^chrome-extension:\/\/[^/]+\/home\.html/.test(u) &&
        (u.includes("onboarding") || u.includes("welcome"))
      ) {
        const page = await t.page();
        if (page) return page;
      }
    }
    await sleep(500);
  }
  return null;
}

async function typeInto(page, selector, text, opts = {}) {
  await page.waitForSelector(selector, { timeout: opts.timeout || 5000 });
  await page.focus(selector);
  await page.type(selector, text, { delay: 25 });
}

// Set an input/textarea's value via DOM directly + fire native React events.
// Reliable than keyboard.type for fast/racy inputs (e.g. SRP textarea).
async function setInputValue(page, selector, value, opts = {}) {
  await page.waitForSelector(selector, { timeout: opts.timeout || 5000 });
  const handle = await page.$(selector);
  if (!handle) throw new Error(`setInputValue: not found ${selector}`);
  await handle.evaluate((el, val) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

// Walk through Flask's onboarding screens. Best-effort selectors against
// MetaMask Flask v13.32.x — Flask UI changes per release, so each click
// is wrapped in clickAny() with multiple fallback selectors and logs the
// one that matched. If a step misses, we leave Chrome open for manual
// completion and abort the smoke.
async function onboardFlask(welcomePage) {
  log("[onboard] starting Flask onboarding flow");
  await welcomePage.bringToFront();

  // Wait briefly for the welcome tab to fully render — Flask may show
  // either the experimental-software warning (fresh) OR the "wallet ready"
  // completion screen (resumed). Branch based on which appeared.
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await welcomePage.$('[data-testid="wallet-ready"]')) {
      log("[onboard] wallet-ready screen detected — onboarding already complete, skipping");
      return true;
    }
    if (await welcomePage.$('[data-testid="experimental-area"]')) break;
    if (await welcomePage.$('[data-testid="get-started"]')) break;
    await sleep(300);
  }

  // Step 0: Flask-specific experimental-software warning. Click "I accept the risks".
  // Note: don't use page.evaluate(window.scrollTo) — LavaMoat scuttles it. ElementHandle.click()
  // auto-scrolls the target into view, so we just need to find + click.
  // Regex is narrowly scoped to the literal warning button — DO NOT include
  // /continue/i here or it will match metametrics Continue when resuming a
  // partially-onboarded profile.
  const acceptedWarning = await clickByText(
    welcomePage,
    [/^i accept the risks$/i, /accept.*risks?$/i],
    5000,
  );
  log("[onboard] flask warning accept:", acceptedWarning);
  await sleep(1500);
  await snap(welcomePage, "onboard-00-warning");

  // Step 1: terms checkbox + "Get started"
  await clickAny(
    welcomePage,
    [
      '[data-testid="onboarding-terms-checkbox"]',
      'input[type="checkbox"]#onboarding__terms-checkbox',
    ],
    10_000,
  );
  await snap(welcomePage, "onboard-01-terms");
  await dumpClickables(welcomePage, "after-warning");

  // Step 2: "Import an existing wallet"
  let importClicked = await clickAny(
    welcomePage,
    [
      '[data-testid="onboarding-import-wallet"]',
      'button[data-testid="onboarding-import-wallet"]',
    ],
    3000,
  );
  if (!importClicked) {
    importClicked = await clickByText(
      welcomePage,
      [
        /import.*secret.*recovery/i, // v13.32+ wording
        /import.*existing.*wallet/i,
        /import.*wallet/i,
        /import.*srp/i,
      ],
      5000,
    );
  }
  if (!importClicked) {
    log("[onboard] could not find Import button — aborting onboarding");
    return false;
  }
  await sleep(2500);
  await snap(welcomePage, "onboard-02-import-clicked");
  await dumpClickables(welcomePage, "after-import-existing");

  // Step 2.5: Flask 13.32+ "Sign in with Google / Apple / Import using SRP"
  // choice screen. Click "Import using Secret Recovery Phrase".
  let srpRouteClicked = await clickAny(
    welcomePage,
    [
      '[data-testid="onboarding-import-srp"]',
      '[data-testid="onboarding-srp-import"]',
    ],
    3000,
  );
  if (!srpRouteClicked) {
    srpRouteClicked = await clickByText(
      welcomePage,
      [/import.*secret.*recovery/i, /import.*using.*recovery/i, /import.*srp/i],
      5000,
    );
  }
  log("[onboard] srp-route click:", srpRouteClicked);
  await sleep(2000);
  await snap(welcomePage, "onboard-02b-srp-route");
  await dumpClickables(welcomePage, "after-srp-route");

  // Step 3: MetaMetrics consent — usually "No thanks". May or may not appear.
  let metaClicked = await clickAny(
    welcomePage,
    [
      '[data-testid="metametrics-no-thanks"]',
      '[data-testid="metametrics-i-agree"]',
    ],
    4000,
  );
  if (!metaClicked) {
    metaClicked = await clickByText(
      welcomePage,
      [/^no thanks$/i, /^i agree$/i, /^agree$/i],
      3000,
    );
  }
  log("[onboard] metametrics click:", metaClicked);
  await sleep(1200);
  await snap(welcomePage, "onboard-03-metametrics");

  // Step 4: SRP entry. v13.32 has two possible paths:
  //   A) textarea-only screen → Continue navigates directly to password
  //   B) textarea screen → Continue navigates to per-word verification → Continue
  // We handle both: fill textarea (if present) → Continue → if per-word inputs
  // appear, fill those → Continue.
  const words = SRP.trim().split(/\s+/);
  if (words.length !== 12) {
    log("[onboard] SRP must be 12 words, got", words.length);
    return false;
  }
  const srpTextarea = '[data-testid="srp-input-import__srp-note"]';
  if (await welcomePage.$(srpTextarea)) {
    // Click the textarea first to ensure it's interactive + focused.
    await welcomePage.click(srpTextarea);
    await sleep(200);
    // page.type is the most reliable single-shot focus+type.
    await welcomePage.type(srpTextarea, SRP, { delay: 80 });
    const txt = await welcomePage
      .$eval(srpTextarea, (el) => el.value)
      .catch(() => "");
    log(`[onboard] textarea length after type: ${txt.length}, expected ${SRP.length}`);
    await sleep(500);
    await snap(welcomePage, "onboard-04-srp-entered");
    await clickAny(welcomePage, ['[data-testid="import-srp-confirm"]'], 6000);
    await sleep(2500);
    await snap(welcomePage, "onboard-05-srp-confirmed");
    await dumpClickables(welcomePage, "after-srp-confirm");
  }

  // Step 4b: if we landed on a per-word verification screen, fill each word.
  const wordSelector = (i) => `[data-testid="import-srp__srp-word-${i}"]`;
  const altSelector = (i) => `[data-testid="srp-input-import__word-${i}"]`;
  const hasPerWord =
    (await welcomePage.$(wordSelector(0))) ||
    (await welcomePage.$(altSelector(0)));
  if (hasPerWord) {
    log("[onboard] per-word SRP verification screen detected");
    // Click "Clear all" first to reset any partially-pasted state.
    await clickByText(welcomePage, [/^clear all$/i], 2000);
    await sleep(500);
    const sel = (await welcomePage.$(wordSelector(0))) ? wordSelector : altSelector;
    for (let i = 0; i < 12; i++) {
      try {
        await welcomePage.waitForSelector(sel(i), { timeout: 4000 });
        await welcomePage.focus(sel(i));
        await welcomePage.keyboard.down("Control");
        await welcomePage.keyboard.press("KeyA");
        await welcomePage.keyboard.up("Control");
        await welcomePage.keyboard.press("Delete");
        await welcomePage.keyboard.type(words[i], { delay: 30 });
      } catch (err) {
        log(`[onboard] could not fill word input ${i}: ${err.message}`);
        return false;
      }
    }
    log("[onboard] filled all 12 word inputs via keyboard");
    await sleep(800);
    await snap(welcomePage, "onboard-04b-words-entered");
    await clickAny(welcomePage, ['[data-testid="import-srp-confirm"]'], 6000);
    await sleep(2500);
    await snap(welcomePage, "onboard-05b-words-confirmed");
    await dumpClickables(welcomePage, "after-words-confirm");
  }

  // Step 6: create password
  try {
    await typeInto(welcomePage, '[data-testid="create-password-new-input"]', PASSWORD);
    await typeInto(welcomePage, '[data-testid="create-password-confirm-input"]', PASSWORD);
  } catch (err) {
    log("[onboard] password input failed:", err.message);
    return false;
  }
  // Terms checkbox/label — only click if not already checked.
  const termsChecked = await welcomePage
    .$eval('[data-testid="create-password-terms"] input[type="checkbox"]', (el) => el.checked)
    .catch(() => false);
  if (!termsChecked) {
    await clickAny(welcomePage, ['[data-testid="create-password-terms"]'], 3000);
  }
  await sleep(400);
  await clickAny(welcomePage, [
    '[data-testid="create-password-submit"]',
    '[data-testid="create-password-import"]',
  ]);
  await sleep(3000);
  await snap(welcomePage, "onboard-06-password");
  await dumpClickables(welcomePage, "after-password");

  // Step 7a: Skip "Set up Windows Hello" passkey prompt
  await clickAny(welcomePage, [
    '[data-testid="passkey-maybe-later-button"]',
  ], 8000);
  await sleep(1500);
  await snap(welcomePage, "onboard-07a-passkey-skipped");
  await dumpClickables(welcomePage, "after-passkey");

  // Step 7b: walk through any remaining completion screens
  // (metametrics consent, pin-extension prompt, "Done", etc.)
  for (let i = 0; i < 6; i++) {
    const clicked = await clickAny(welcomePage, [
      '[data-testid="metametrics-i-agree"]',
      '[data-testid="metametrics-no-thanks"]',
      '[data-testid="onboarding-complete-done"]',
      '[data-testid="pin-extension-next"]',
      '[data-testid="pin-extension-done"]',
      '[data-testid="onboarding-complete-button"]',
    ], 3000);
    if (!clicked) {
      const textClicked = await clickByText(
        welcomePage,
        [/^continue$/i, /^done$/i, /^got it$/i, /^next$/i, /^enable$/i],
        2000,
      );
      if (!textClicked) break;
    }
    await sleep(1500);
  }
  await snap(welcomePage, "onboard-07-complete");

  log("[onboard] finished onboarding flow");
  return true;
}

// ── play steps ─────────────────────────────────────────────────────────
const STEPS = [
  {
    label: "01-loaded",
    do: async (page) => {
      await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 30_000 });
      await sleep(1000);
    },
  },
  {
    label: "02-connect",
    do: async (page) => {
      await dumpClickables(page, "site-buttons");
      const ok = await clickByText(page, [/^connect$/i, /^reconnect$/i], 6000);
      log("[connect] clicked:", ok);
      // Wait for the snap install popup chain to complete. The site enables
      // the action cards (Get Account etc.) once installedSnap is truthy —
      // poll for the Get account button's :disabled attribute to flip.
      const deadline = Date.now() + 60_000;
      let installed = false;
      while (Date.now() < deadline) {
        const enabled = await page
          .evaluate(() => {
            const btns = Array.from(document.querySelectorAll("button"));
            const ga = btns.find((b) => /get account/i.test(b.textContent || ""));
            return ga && !ga.disabled;
          })
          .catch(() => false);
        if (enabled) {
          installed = true;
          break;
        }
        await sleep(1000);
      }
      log("[connect] install completed:", installed);
      await sleep(1500);
    },
  },
  {
    label: "03-get-account",
    do: async (page) => {
      const buttons = await page.$$("button");
      for (const b of buttons) {
        const txt = (await page.evaluate((el) => el.textContent || "", b)).trim();
        if (/get account/i.test(txt)) {
          await b.click();
          break;
        }
      }
      await sleep(2000);
    },
  },
  {
    label: "04-get-balance",
    do: async (page) => {
      const buttons = await page.$$("button");
      for (const b of buttons) {
        const txt = (await page.evaluate((el) => el.textContent || "", b)).trim();
        if (/get balance/i.test(txt)) {
          await b.click();
          break;
        }
      }
      await sleep(3000);
    },
  },
  {
    label: "05-show-account",
    do: async (page) => {
      const buttons = await page.$$("button");
      for (const b of buttons) {
        const txt = (await page.evaluate((el) => el.textContent || "", b)).trim();
        if (/show account/i.test(txt)) {
          await b.click();
          break;
        }
      }
      await sleep(4000);
    },
  },
  {
    label: "06-sign-adr036",
    do: async (page) => {
      const buttons = await page.$$("button");
      for (const b of buttons) {
        const txt = (await page.evaluate((el) => el.textContent || "", b)).trim();
        if (/sign adr-036/i.test(txt)) {
          await b.click();
          break;
        }
      }
      await sleep(4000);
    },
  },
  {
    label: "07-send-dgn",
    do: async (page) => {
      const buttons = await page.$$("button");
      for (const b of buttons) {
        const txt = (await page.evaluate((el) => el.textContent || "", b)).trim();
        if (/send 0\.1 dgn/i.test(txt)) {
          await b.click();
          break;
        }
      }
      await sleep(6000);
    },
  },
];

// ── vision review (optional) ───────────────────────────────────────────
async function visionReview(shotFiles) {
  if (!process.env.ANTHROPIC_API_KEY) {
    log("[review] skipped — ANTHROPIC_API_KEY not set");
    return;
  }
  let Anthropic;
  try {
    Anthropic = require("@anthropic-ai/sdk").default;
  } catch (err) {
    log("[review] @anthropic-ai/sdk not installed:", err.message);
    return;
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const images = shotFiles.map((f) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: fs.readFileSync(f).toString("base64"),
    },
  }));
  log("[review] sending", images.length, "screenshots to Claude Sonnet for review");
  const resp = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: [
          ...images,
          {
            type: "text",
            text:
              "You are reviewing screenshots from an automated smoke run of " +
              "the Dungeon MetaMask Snap. The companion site at localhost:8000 " +
              "should show: a connected state, then JSON outputs under each " +
              "action card after clicking. " +
              "For each screenshot, briefly say whether the UI looks correct, " +
              "and flag anything that looks broken: stuck loaders, error " +
              "boxes, missing JSON output, unexpected popup state, etc. " +
              "Format as a markdown punch-list. Be specific about which " +
              "screenshot number has the issue.",
          },
        ],
      },
    ],
  });
  const text = resp.content.map((c) => c.text || "").join("\n");
  fs.writeFileSync(path.join(SESSION_DIR, "vision-review.md"), text);
  log("[review] saved vision-review.md");
}

// ── main ───────────────────────────────────────────────────────────────
(async function main() {
  ensureFlask();
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  log("session dir:", SESSION_DIR);
  log("profile dir:", PROFILE_DIR);
  log("flask dir:  ", FLASK_DIR);
  log("site url:   ", SITE_URL);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    userDataDir: PROFILE_DIR,
    defaultViewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${FLASK_DIR}`,
      `--load-extension=${FLASK_DIR}`,
      "--no-sandbox",
      "--disable-features=ExtensionsManifestV3Only",
    ],
  });
  attachPopupHandler(browser);

  // Check if Flask is already onboarded; if a welcome tab appears,
  // try the automated onboarding flow.
  const welcome = await findFlaskWelcome(browser, 8000);
  if (welcome) {
    log("[boot] Flask welcome tab detected — running onboarding");
    const ok = await onboardFlask(welcome);
    if (!ok) {
      log(
        "[boot] onboarding stalled. Complete Flask onboarding in the open Chrome window, then re-run this script. Browser will remain open for 5 min.",
      );
      await sleep(5 * 60 * 1000);
      await browser.close();
      return;
    }
  } else {
    log("[boot] no welcome tab — assuming Flask already onboarded");
  }

  const pages = await browser.pages();
  const page = pages.find((p) => !/chrome-extension/.test(p.url())) || (await browser.newPage());
  await page.bringToFront();

  const shots = [];
  for (const step of STEPS) {
    log("> step:", step.label);
    try {
      await step.do(page);
      shots.push(await snap(page, step.label));
    } catch (err) {
      log("[error]", step.label, err.message);
      try {
        shots.push(await snap(page, `${step.label}-error`));
      } catch {}
    }
  }

  if (REVIEW) await visionReview(shots);

  log("done — leaving browser open for 30s so you can inspect");
  await sleep(30_000);
  await browser.close();
  log("browser closed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
