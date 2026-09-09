#!/usr/bin/env node
// The self-test for `bbe contrast`.
//
// A detector that has only ever returned clean has not been tested. So the
// fixture plants four things and this asserts each one lands in ITS OWN
// category, with the right token named, and that the correctly-wired control
// is flagged by neither check.
//
//   1. half-wired, contrast survives   -> HALF-WIRED only  (--plank moved, --slab stuck)
//   2. genuine low contrast, wired     -> CONTRAST only, both schemes (--pale-fg/--pale-bg)
//   3. svg stroke vanishing in dark    -> CONTRAST (kind stroke, dark) and HALF-WIRED
//      ...and it is planted inside an @import-ed sheet, because document.styleSheets
//      does not list those and the first cut of this tool walked straight past them.
//   4. control, both sides wired       -> neither
//   plus two look-alikes that must stay clean: a <use> sprite reference (its
//   ink is in the referenced document, so it is counted as unmeasured and the
//   count is reported), and screen-reader-only clipped text.
//
//   node test/contrast.mjs

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import {
  scanPage, contrastFindings, halfWiredFindings, groupContrast, groupHalfWired,
  parseColor, contrastRatio, requiredRatio, over
} from '../tools/contrast-scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'contrast', 'fixture.html');

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

// --- colour maths, measured once against values anyone can verify by hand ---
console.log('-- colour maths --');
check('white on black is 21:1', Math.abs(contrastRatio(parseColor('#fff'), parseColor('#000')) - 21) < 0.01);
check('a colour on itself is 1:1', Math.abs(contrastRatio(parseColor('#FBF7F9'), parseColor('#FBF7F9')) - 1) < 0.001);
check('#1A0A14 on #FBF7F9 is 18.02:1',
  Math.abs(contrastRatio(parseColor('#1A0A14'), parseColor('#FBF7F9')) - 18.02) < 0.02);
check('50% black over white composites to mid grey',
  Math.round(over(parseColor('rgba(0,0,0,0.5)'), parseColor('#fff')).r) === 128);
check('24px normal text only needs 3:1', requiredRatio({ kind: 'text', fontSize: 24, fontWeight: 400 }) === 3);
check('18.66px at 700 only needs 3:1', requiredRatio({ kind: 'text', fontSize: 18.66, fontWeight: 700 }) === 3);
check('18.66px at 400 still needs 4.5:1', requiredRatio({ kind: 'text', fontSize: 18.66, fontWeight: 400 }) === 4.5);
check('an svg stroke is a graphical object at 3:1', requiredRatio({ kind: 'stroke', fontSize: 12, fontWeight: 400 }) === 3);

// --- the planted defects ---------------------------------------------------
console.log('');
console.log('-- planted defects --');

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-lcd-text', '--force-color-profile=srgb', '--allow-file-access-from-files']
});
const page = await browser.newPage();
const raw = await scanPage(page, { url: pathToFileURL(FIXTURE).href, label: FIXTURE },
  { scheme: 'both', viewport: { width: 1440, height: 1000 } });
await browser.close();

const cGroups = groupContrast(contrastFindings(raw.byScheme));
const hGroups = groupHalfWired(halfWiredFindings(raw.byScheme));
const hits = (groups, pred) => groups.filter(pred);
const sels = (g) => g.examples.map(e => e.sel).join(',');

check('the scan actually measured something', raw.byScheme.light.length > 0 && raw.byScheme.dark.length > 0,
  `light ${raw.byScheme.light.length}, dark ${raw.byScheme.dark.length} measurements`);
check('the CORS-blocked linked stylesheet was read anyway', raw.ruleCount >= 7,
  `${raw.ruleCount} author rules indexed`);

// 1. half-wired with the contrast surviving
const d1 = hits(hGroups, g => g.movedToken === '--plank' && g.stuckToken === '--slab');
check('DEFECT 1 caught as HALF-WIRED (--plank moved, --slab stuck)', d1.length === 1,
  d1.length ? `${d1[0].side}, light ${d1[0].light.ratio}:1 dark ${d1[0].dark.ratio}:1` : 'not found');
check('DEFECT 1 was invisible to the contrast check, which is the point',
  d1.length === 1 && d1[0].light.ratio >= 4.5 && d1[0].dark.ratio >= 4.5,
  'both schemes clear 4.5:1 and it still got flagged');
check('DEFECT 1 raised no CONTRAST finding',
  hits(cGroups, g => /--plank|--slab/.test(g.fgName + g.bgName)).length === 0);

// 2. genuine low contrast, correctly wired
const d2 = hits(cGroups, g => g.fgName.includes('--pale-fg') && g.bgName.includes('--pale-bg'));
check('DEFECT 2 caught as CONTRAST in both schemes', d2.length === 2,
  d2.map(g => `${g.scheme} ${g.worst}:1`).join(', ') || 'not found');
check('DEFECT 2 is under the 4.5:1 bar in both', d2.length === 2 && d2.every(g => g.worst < 4.5 && g.need === 4.5));
check('DEFECT 2 raised no HALF-WIRED finding, because both tokens flip',
  hits(hGroups, g => /--pale/.test((g.movedToken || '') + (g.stuckToken || ''))).length === 0);

// 3. the svg stroke that vanishes in dark
const d3 = hits(cGroups, g => g.kind === 'stroke' && g.scheme === 'dark');
check('DEFECT 3 caught as a CONTRAST failure on an SVG STROKE, not text', d3.length === 1,
  d3.length ? `${d3[0].worst}:1 on ${sels(d3[0])}, needs ${d3[0].need}:1` : 'not found');
check('DEFECT 3 is measured at 1:1, the arrow is literally invisible',
  d3.length === 1 && d3[0].worst <= 1.02);
check('DEFECT 3 names the token that stuck, not just the pixel',
  d3.length === 1 && d3[0].fgName === 'var(--glyph)' && d3[0].bgName === 'var(--well)',
  d3.length ? `fg ${d3[0].fgName} bg ${d3[0].bgName}` : '');
check('DEFECT 3 also caught as HALF-WIRED (--well moved, --glyph stuck)',
  hits(hGroups, g => g.movedToken === '--well' && g.stuckToken === '--glyph').length === 1);
check('DEFECT 3 resolved currentColor to the color rule on the wrapper',
  d3.length === 1 && /svg/.test(d3[0].fgRule.sel));
check('DEFECT 3 was found inside an @import-ed sheet, which document.styleSheets does not list',
  d3.length === 1 && /fixture-kit\.css/.test(d3[0].fgRule.href || ''),
  d3.length ? (d3[0].fgRule.href || '').split('/').pop() : '');

// 4. the control
const touchesControl = (g) => sels(g).includes('control') ||
  /--ok-fg|--ok-bg/.test((g.fgName || '') + (g.bgName || '') + (g.movedToken || '') + (g.stuckToken || ''));
check('CONTROL is not in the CONTRAST findings', hits(cGroups, touchesControl).length === 0);

// two things that LOOK like defects and are not, both of which this tool
// reported as real failures before they were handled
const anyExample = (groups, rx) => groups.some(g => rx.test(sels(g)));
check('CONTROL 2: a <use> sprite is not flagged, its ink is in another document',
  !anyExample(cGroups, /use/) && !anyExample(hGroups, /use/));
check('CONTROL 2: the unmeasured sprite is REPORTED, not silently dropped',
  raw.notes.some(n => /<use>/.test(n)), raw.notes.find(n => /<use>/.test(n)) || 'no note');
check('CONTROL 3: screen-reader-only text is not flagged',
  !anyExample(cGroups, /span\.sr/) && !anyExample(hGroups, /span\.sr/));
check('CONTROL is not in the HALF-WIRED findings', hits(hGroups, touchesControl).length === 0);

// and the totals, so a future change that starts flagging the page wholesale is loud
check('exactly 3 contrast root causes and 2 half-wired root causes',
  cGroups.length === 3 && hGroups.length === 2,
  `contrast ${cGroups.length}, half-wired ${hGroups.length}`);

console.log('');
console.log(failures === 0 ? 'contrast self-test: PASS' : `contrast self-test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
