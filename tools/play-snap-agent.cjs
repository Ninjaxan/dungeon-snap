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
    const page = await target.page();
    if (!page) return;
    log("[popup] detected:", url);
    try {
      await page.waitForSelector("button", { timeout: 8000 });
      await sleep(800);
      // MetaMask uses data-testid="confirm-btn" for the primary CTA on most
      // approval surfaces (install snap, connect, sign, send). The "Next"
      // permission step uses page-container-footer-next.
      const clicked = await clickAny(
        page,
        [
          '[data-testid="confirm-btn"]',
          '[data-testid="confirmation-submit-button"]',
          '[data-testid="page-container-footer-next"]',
          '[data-testid="snap-install-warning-modal-confirm"]',
          'button.btn-primary',
        ],
        6000,
      );
      log("[popup] clicked:", clicked || "<none — left for manual review>");
    } catch (err) {
      log("[popup] error:", err.message);
    }
  });
}

async function snap(page, label) {
  const file = path.join(SHOTS, `${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log("[shot]", label);
  return file;
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
      // Connect button has different testids depending on installed state.
      // Just click anything that says "Connect" or "Reconnect".
      const buttons = await page.$$("button");
      for (const b of buttons) {
        const txt = (await page.evaluate((el) => el.textContent || "", b)).trim();
        if (/^(connect|reconnect)$/i.test(txt)) {
          await b.click();
          break;
        }
      }
      await sleep(5000); // wait for popup chain to complete
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

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
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
