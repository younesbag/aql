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
  if (!found) throw new Error('No Chromium-based browser found. Set X_VISUAL_BROWSER.');
  return found;
}

function cap(value, maximum) {
  return Math.min(value, maximum);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.copy || !args.png || !args.report) {
    throw new Error('Usage: qa_visual.js --input design.html --copy locked-copy.json --png final.png --report qa-auto.json');
  }

  const input = path.resolve(args.input);
  const copyPath = path.resolve(args.copy);
  const pngPath = path.resolve(args.png);
  const reportPath = path.resolve(args.report);
  const minFont = Number(args['min-font'] || 24);
  for (const required of [input, copyPath, pngPath]) {
    if (!fs.existsSync(required)) throw new Error(`Required file not found: ${required}`);
  }

  const locked = JSON.parse(fs.readFileSync(copyPath, 'utf8'));
  const records = locked.records;
  if (!records || Array.isArray(records) || typeof records !== 'object') {
    throw new Error('locked-copy.json must contain a records object.');
  }
  for (const [key, value] of Object.entries(records)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Copy record ${key} must be a non-empty string.`);
    }
  }

  const { chromium } = loadPackage('playwright');
  const sharp = loadPackage('sharp');
  const executablePath = findBrowser(chromium);
  const metadata = await sharp(pngPath).metadata();
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const browser = await chromium.launch({ headless: true, executablePath });

  let dom;
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(input).href, { waitUntil: 'load' });
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });

    dom = await page.evaluate(({ expected, defaultMinFont }) => {
      const normalize = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
      const canvas = document.querySelector('[data-canvas]');
      if (!canvas) return { canvasMissing: true };
      const canvasRect = canvas.getBoundingClientRect();
      const copyElements = [...canvas.querySelectorAll('[data-copy-id]')];
      const ids = copyElements.map((element) => element.dataset.copyId);
      const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      const missingIds = Object.keys(expected).filter((id) => !ids.includes(id));
      const extraIds = [...new Set(ids.filter((id) => !(id in expected)))];
      const mismatches = [];
      for (const element of copyElements) {
        const id = element.dataset.copyId;
        if (!(id in expected)) continue;
        const actual = normalize(element.textContent);
        const wanted = normalize(expected[id]);
        if (actual !== wanted) mismatches.push({ id, expected: wanted, actual });
      }

      const unregisteredText = [];
      const walker = document.createTreeWalker(canvas, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const value = normalize(node.textContent);
        if (!value) continue;
        const parent = node.parentElement;
        if (!parent) continue;
        if (parent.closest('[data-copy-id], script, style, svg, template')) continue;
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        unregisteredText.push(value);
      }

      const overflow = [];
      const fontIssues = [];
      const bidiIssues = [];
      for (const element of copyElements) {
        const id = element.dataset.copyId;
        if (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2) {
          overflow.push({ id, client: [element.clientWidth, element.clientHeight], scroll: [element.scrollWidth, element.scrollHeight] });
        }
        const style = getComputedStyle(element);
        const size = Number.parseFloat(style.fontSize);
        const minimum = Number(element.dataset.minFont || defaultMinFont);
        if (size + 0.01 < minimum) fontIssues.push({ id, size, minimum });
        if (/[\u0600-\u06FF]/u.test(element.textContent) && style.direction !== 'rtl' && !element.closest('[data-ltr]')) {
          bidiIssues.push({ id, direction: style.direction });
        }
      }

      const outOfBounds = [];
      const qaBoxes = [...canvas.querySelectorAll('[data-qa-box]')];
      for (const element of qaBoxes) {
        const rect = element.getBoundingClientRect();
        if (
          rect.left < canvasRect.left - 1 || rect.top < canvasRect.top - 1 ||
          rect.right > canvasRect.right + 1 || rect.bottom > canvasRect.bottom + 1
        ) {
          outOfBounds.push({ name: element.dataset.qaBox || element.className || element.tagName });
        }
      }

      const overlap = [];
      const groups = new Map();
      for (const element of qaBoxes) {
        const group = element.dataset.qaGroup;
        if (!group || element.dataset.qaOverlap === 'allow') continue;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(element);
      }
      for (const [group, elements] of groups.entries()) {
        for (let i = 0; i < elements.length; i += 1) {
          for (let j = i + 1; j < elements.length; j += 1) {
            const a = elements[i].getBoundingClientRect();
            const b = elements[j].getBoundingClientRect();
            const intersectionWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const intersectionHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (intersectionWidth > 2 && intersectionHeight > 2) {
              overlap.push({ group, first: i, second: j, area: Math.round(intersectionWidth * intersectionHeight) });
            }
          }
        }
      }

      const externalResources = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => /^https?:/i.test(name));

      return {
        canvasMissing: false,
        canvas: { width: Math.round(canvasRect.width), height: Math.round(canvasRect.height) },
        copyCount: copyElements.length,
        duplicateIds,
        missingIds,
        extraIds,
        mismatches,
        unregisteredText: [...new Set(unregisteredText)],
        overflow,
        fontIssues,
        bidiIssues,
        outOfBounds,
        overlap,
        externalResources
      };
    }, { expected: records, defaultMinFont: minFont });
  } finally {
    await browser.close();
  }

  const dimensionsMatch = !dom.canvasMissing && dom.canvas.width === width && dom.canvas.height === height;
  let deductions = 0;
  deductions += cap((dom.missingIds?.length || 0) * 12, 25);
  deductions += cap((dom.mismatches?.length || 0) * 12, 25);
  deductions += cap((dom.extraIds?.length || 0) * 8, 15);
  deductions += cap((dom.duplicateIds?.length || 0) * 8, 15);
  deductions += cap((dom.unregisteredText?.length || 0) * 8, 15);
  deductions += cap((dom.overflow?.length || 0) * 6, 20);
  deductions += cap((dom.outOfBounds?.length || 0) * 8, 20);
  deductions += cap((dom.overlap?.length || 0) * 5, 15);
  deductions += cap((dom.bidiIssues?.length || 0) * 8, 15);
  deductions += cap((dom.fontIssues?.length || 0) * 4, 15);
  deductions += cap((dom.externalResources?.length || 0) * 5, 10);
  if (!dimensionsMatch) deductions += 15;
  const score = Math.max(0, 100 - deductions);

  const fatalErrors = [];
  const fatalMap = [
    ['canvas missing', dom.canvasMissing ? [true] : []],
    ['missing copy IDs', dom.missingIds],
    ['copy mismatches', dom.mismatches],
    ['extra copy IDs', dom.extraIds],
    ['duplicate copy IDs', dom.duplicateIds],
    ['unregistered visible text', dom.unregisteredText],
    ['text overflow', dom.overflow],
    ['elements outside canvas', dom.outOfBounds],
    ['peer boxes overlap', dom.overlap],
    ['RTL/Bidi errors', dom.bidiIssues],
    ['text below minimum size', dom.fontIssues],
    ['external network resources', dom.externalResources]
  ];
  for (const [label, items] of fatalMap) {
    if (items && items.length) fatalErrors.push(`${label}: ${items.length}`);
  }
  if (!dimensionsMatch) fatalErrors.push('PNG and canvas dimensions differ');

  const outputDir = path.dirname(pngPath);
  const thumbnail40 = path.join(outputDir, 'thumbnail-40.png');
  const thumbnail20 = path.join(outputDir, 'thumbnail-20.png');
  await sharp(pngPath).resize({ width: Math.max(1, Math.round(width * 0.4)) }).png().toFile(thumbnail40);
  await sharp(pngPath).resize({ width: Math.max(1, Math.round(width * 0.2)) }).png().toFile(thumbnail20);

  const report = {
    passed: score >= 90 && fatalErrors.length === 0,
    score,
    fatalErrors,
    png: { path: pngPath, width, height, format: metadata.format, space: metadata.space },
    thumbnails: { fortyPercent: thumbnail40, twentyPercent: thumbnail20 },
    checks: dom
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exit(2);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
