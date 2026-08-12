#!/usr/bin/env node
/**
 * Design QA capture: screenshots the workbench's key visual states into
 * output/design-qa/ so UI changes can be reviewed as before/after images.
 *
 * Requires a running bridge (`pnpm dev`, default http://127.0.0.1:19790).
 * Uses the machine's cached Playwright chromium; set QA_CHROMIUM to override.
 *
 * Usage: node scripts/design-qa.mjs [--base http://127.0.0.1:19790]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const baseFlag = args.indexOf("--base");
const BASE = baseFlag >= 0 ? args[baseFlag + 1] : (process.env.QA_BASE ?? "http://127.0.0.1:19790");
const OUT = new URL("../output/design-qa/", import.meta.url).pathname;

const CANDIDATE_BROWSERS = [
  process.env.QA_CHROMIUM,
  join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-mac/headless_shell"),
].filter(Boolean);

const executablePath = CANDIDATE_BROWSERS.find((candidate) => existsSync(candidate));
if (!executablePath) {
  console.error("No cached chromium found. Set QA_CHROMIUM=/path/to/headless-shell.");
  process.exit(1);
}

async function assertBridgeUp() {
  try {
    const response = await fetch(`${BASE}/workbench/`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(`Bridge is not serving ${BASE}/workbench/ — start it with \`pnpm dev\` first. (${error.message})`);
    process.exit(1);
  }
}

/** @param theme {"paper" | "carbon"} */
async function themedPage(browser, theme) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((value) => window.localStorage.setItem("codebridge:web-theme", value), theme);
  return page;
}

async function main() {
  await assertBridgeUp();
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  const captured = [];

  async function capture(name, theme, url, actions) {
    const page = await themedPage(browser, theme);
    await page.goto(url, { waitUntil: "networkidle" });
    if (actions) await actions(page);
    await page.waitForTimeout(400);
    const file = `${name}-${theme}.png`;
    await page.screenshot({ path: join(OUT, file) });
    captured.push({ name, theme, file });
    await page.close();
    console.log(`captured ${file}`);
  }

  for (const theme of ["paper", "carbon"]) {
    await capture("workbench", theme, `${BASE}/workbench/`);
    await capture("palette", theme, `${BASE}/workbench/`, async (page) => {
      await page.keyboard.press("Meta+k");
      await page.waitForTimeout(200);
    });
    await capture("preview", theme, `${BASE}/workbench/?preview=design`);
    await capture("preview-states", theme, `${BASE}/workbench/?preview=design&state=states`);
  }

  writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(), base: BASE, viewport: "1440x900", shots: captured }, null, 2) + "\n");
  await browser.close();
  console.log(`\n${captured.length} screenshots written to output/design-qa/`);
}

await main();
