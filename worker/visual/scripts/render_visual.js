#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function loadPackage(name) {
  try {
    return require(name);
  } catch (_) {
    const roots = [
      process.env.X_VISUAL_NODE_MODULES,
      process.env.NODE_PATH,
      process.env.USERPROFILE && path.join(
        process.env.USERPROFILE,
        '.cache', 'codex-runtimes', 'codex-primary-runtime',
        'dependencies', 'node', 'node_modules'
      )
    ].filter(Boolean);
    for (const root of roots) {
      try {
        return require(path.join(root, name));
      } catch (_) {
        // Continue to the next deterministic local runtime location.
      }
    }
    throw new Error(`Cannot load ${name}. Use load_workspace_dependencies and set X_VISUAL_NODE_MODULES.`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

function findBrowser(chromium) {
  const candidates = [
    process.env.X_VISUAL_BROWSER,
    chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('No Chromium-based browser found. Set X_VISUAL_BROWSER to Edge or Chrome.');
  }
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    throw new Error('Usage: render_visual.js --input design.html --output final.png [--width 2560 --height 1440]');
  }

  const input = path.resolve(args.input);
  const output = path.resolve(args.output);
  const width = Number(args.width || 2560);
  const height = Number(args.height || 1440);
  if (!fs.existsSync(input)) throw new Error(`Input HTML not found: ${input}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const { chromium } = loadPackage('playwright');
  const sharp = loadPackage('sharp');
  const executablePath = findBrowser(chromium);
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--allow-file-access-from-files', '--font-render-hinting=none']
  });

  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
      colorScheme: 'light'
    });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(pathToFileURL(input).href, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });

    const canvas = page.locator('[data-canvas]');
    if (await canvas.count() !== 1) {
      throw new Error('The HTML must contain exactly one [data-canvas] element.');
    }
    const box = await canvas.boundingBox();
    if (!box) throw new Error('The [data-canvas] element is not visible.');
    if (Math.round(box.width) !== width || Math.round(box.height) !== height) {
      throw new Error(`Canvas is ${Math.round(box.width)}x${Math.round(box.height)}, expected ${width}x${height}.`);
    }
    if (pageErrors.length) throw new Error(`Page errors: ${pageErrors.join(' | ')}`);

    await canvas.screenshot({ path: output, type: 'png', omitBackground: false });
    const temporary = `${output}.srgb.png`;
    await sharp(output)
      .toColourspace('srgb')
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(temporary);
    fs.rmSync(output);
    fs.renameSync(temporary, output);

    const metadata = await sharp(output).metadata();
    process.stdout.write(JSON.stringify({
      ok: true,
      input,
      output,
      width: metadata.width,
      height: metadata.height,
      browser: executablePath
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
