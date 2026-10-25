import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pageProblems, withPolicy } from '../src/main/create/html';
import { imageInfo } from '../src/main/create/images';
import { safeFileName } from '../src/main/create/output';
import { buildModel, cube, cylinder, sphere, toStl } from '../src/main/create/solid';
import { ModelSpec, solidProblem } from '../src/main/create/specs';
import { jsonSchema } from '../src/main/capabilities/registry';
import { colName, excelDate } from '../src/main/create/xlsx';
import { extractEntry, listZip } from '../src/main/video/unzip';
import { makeHarness, type Harness } from './helpers';

let h: Harness;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A 2×1 PNG header (enough for Keo's size check; the pixels do not matter here). */
function png(w = 640, hgt = 480): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(hgt, 20);
  return b;
}

function setup() {
  const docs = tmp('keo-docs-');
  const home = tmp('keo-home-');
  const opened: string[] = [];
  h = makeHarness({ deps: { documentsDir: docs, homeDir: home, openPath: async (p) => (opened.push(p), true) } });
  return { docs, home, out: path.join(docs, 'Keo'), opened };
}

async function run(capabilityId: string, input: unknown, conversationId: string | null = null) {
  const a = h.services.registry.admit({ capabilityId, input, origin: 'model', correlationId: 'c' });
  if (!a.ok) return { rejected: a.reason } as const;
  const t = h.services.tasks.create({ title: capabilityId, rationale: '', origin: 'model', conversationId, correlationId: 'c', steps: [{ admission: a, title: capabilityId, dependsOnIndexes: [] }] });
  h.services.tasks.submit(t.id);
  const step = h.services.tasks.get(t.id)!.steps[0]!;
  const needed = step.state === 'awaiting_authorization';
  if (needed) h.services.tasks.approveStep(step.id, step.inputHash);
  else h.services.tasks.pump();
  for (let i = 0; i < 500 && !['completed', 'failed', 'cancelled'].includes(h.services.tasks.get(t.id)!.state); i++) await new Promise((r) => setTimeout(r, 20));
  return { needed, preview: a.preview, step: h.services.tasks.get(t.id)!.steps[0]! } as const;
}

function ok<T = Made>(r: Awaited<ReturnType<typeof run>>): T {
  if ('rejected' in r) throw new Error(r.rejected);
  expect(r.step.error ?? null).toBeNull();
  expect(r.step.state).toBe('succeeded');
  return r.step.result as T;
}

/** The approval tier Keo gave the step. */
const tier = (r: Awaited<ReturnType<typeof run>>) => ('rejected' in r ? null : r.preview.autoTier);

type Made = { path: string; fileName: string; folder: string; bytes: number; replaced: boolean; details: Record<string, unknown> };

/** One part of a zip package as text, read with Keo's own unzip. */
async function part(file: string, name: string): Promise<string> {
  const entries = await listZip(file);
  const e = entries.find((x) => x.name === name);
  if (!e) throw new Error(`${name} missing; has ${entries.map((x) => x.name).join(', ')}`);
  const out = path.join(tmp('keo-part-'), 'part');
  await extractEntry(file, e, out);
  return fs.readFileSync(out, 'utf8');
}

/** Every XML part parses as well-formed enough: balanced tags, one root. */
function wellFormed(xml: string) {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) expect(stack.pop()).toBe(m[2]);
    else stack.push(m[2]!);
  }
  expect(stack).toEqual([]);
}

async function allXmlWellFormed(file: string) {
  for (const e of await listZip(file)) if (/\.(xml|rels)$/.test(e.name)) wellFormed(await part(file, e.name));
}

describe('Word documents', () => {
  it('makes a .docx with headings, formatting, lists, a table, a page break and a picture', async () => {
    const { out, home } = setup();
    const pic = path.join(home, 'Pictures', 'logo.png');
    fs.mkdirSync(path.dirname(pic), { recursive: true });
    fs.writeFileSync(pic, png());
    const r = await run('create.document', {
      title: 'Service Agreement',
      subtitle: 'Template',
      blocks: [
        { type: 'heading', text: '1. Parties', level: 1 },
        { type: 'paragraph', text: 'This agreement is between **[Client name]** and *[Provider]* & partners.' },
        { type: 'bullets', items: ['Scope', 'Fees'] },
        { type: 'bullets', items: ['First', 'Second'], ordered: true },
        { type: 'table', header: ['Item', 'Price'], rows: [['Design', '$500'], ['Build', '$1,000']] },
        { type: 'page_break' },
        { type: 'image', path: pic, caption: 'Our logo' },
      ],
    });
    expect(tier(r)).toBe('routine');
    const made = ok(r);
    expect(made.path).toBe(path.join(out, 'Service Agreement.docx'));
    expect(made.details.tables).toBe(1);
    const doc = await part(made.path, 'word/document.xml');
    wellFormed(doc);
    expect(doc).toContain('<w:pStyle w:val="Title"/>');
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toMatch(/<w:b\/><\/w:rPr><w:t xml:space="preserve">\[Client name\]<\/w:t>/);
    expect(doc).toMatch(/<w:i\/><\/w:rPr><w:t xml:space="preserve">\[Provider\]<\/w:t>/);
    expect(doc).toContain('&amp; partners');
    expect(doc).toContain('<w:numId w:val="1"/>');
    expect(doc).toContain('<w:numId w:val="2"/>');
    expect(doc.match(/<w:tr>/g)?.length).toBe(3);
    expect(doc).toContain('<w:br w:type="page"/>');
    expect(doc).toContain('r:embed="rId11"');
    expect(await part(made.path, 'word/_rels/document.xml.rels')).toContain('media/image1.png');
    expect(await part(made.path, 'word/numbering.xml')).toContain('<w:startOverride w:val="1"/>');
    expect(await part(made.path, 'docProps/core.xml')).toContain('<dc:title>Service Agreement</dc:title>');
    await allXmlWellFormed(made.path);
  });

  it('never overwrites: a second file with the same name becomes “(2)”', async () => {
    const { out } = setup();
    const spec = { title: 'Notes', blocks: [{ type: 'paragraph', text: 'Hello' }] };
    const a = ok(await run('create.document', spec));
    const before = fs.readFileSync(a.path);
    const b = ok(await run('create.document', spec));
    expect(b.path).toBe(path.join(out, 'Notes (2).docx'));
    expect(fs.readFileSync(a.path).equals(before)).toBe(true);
  });

  it('refuses pictures outside the allowed folders', async () => {
    setup();
    const outside = path.join(tmp('keo-elsewhere-'), 'x.png');
    fs.writeFileSync(outside, png());
    const r = await run('create.document', { title: 'T', blocks: [{ type: 'image', path: outside }] });
    expect('rejected' in r && r.rejected).toMatch(/outside the folders/);
  });
});

describe('PowerPoint decks', () => {
  it('makes a themed .pptx with every layout, a picture and a chart', async () => {
    const { home } = setup();
    const pic = path.join(home, 'photo.png');
    fs.writeFileSync(pic, png(1200, 800));
    const made = ok(
      await run('create.presentation', {
        title: 'Rocket Launch Plan',
        theme: 'ocean',
        accent: '#FF8800',
        slides: [
          { layout: 'title', title: 'Rocket Launch Plan', subtitle: 'Q3 review' },
          { layout: 'section', title: 'Where we are' },
          { layout: 'bullets', title: 'Highlights', bullets: ['Engine test **passed**', 'Budget on track', 'Team of 12'] },
          { layout: 'two_column', title: 'Pros and cons', leftHeading: 'Pros', bullets: ['Fast'], rightHeading: 'Cons', right: ['Costly'] },
          { layout: 'image', title: 'The pad', image: pic, bullets: ['Ready in May'] },
          { layout: 'chart', title: 'Spend', chart: { kind: 'column', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Plan', values: [10, 20, 30] }, { name: 'Actual', values: [12, 18, 31] }], unit: '$' } },
          { layout: 'chart', title: 'Share', chart: { kind: 'bar', labels: ['A', 'B'], series: [{ name: 'S', values: [60, -40] }], unit: '%' } },
          { layout: 'quote', title: 'Ada', quote: 'That brain of mine is something more than merely mortal.' },
          { layout: 'closing', title: 'Thank you', subtitle: 'Questions?' },
        ],
      }),
    );
    expect(made.fileName).toBe('Rocket Launch Plan.pptx');
    expect(made.details.slides).toBe(9);
    const entries = (await listZip(made.path)).map((e) => e.name);
    expect(entries.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(9);
    expect(entries).toContain('ppt/media/image5.png');
    const pres = await part(made.path, 'ppt/presentation.xml');
    expect(pres.match(/<p:sldId /g)).toHaveLength(9);
    expect(pres).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
    const s1 = await part(made.path, 'ppt/slides/slide1.xml');
    expect(s1).toContain('<a:t>Rocket Launch Plan</a:t>');
    expect(s1).toContain('val="0B3C49"'); // ocean background
    expect(s1).toContain('val="FF8800"'); // the user's accent
    const s3 = await part(made.path, 'ppt/slides/slide3.xml');
    expect(s3).toContain('<a:buChar char="•"/>');
    expect(s3).toMatch(/b="1"[^>]*><a:solidFill><a:srgbClr val="[0-9A-F]{6}"\/><\/a:solidFill><a:latin typeface="Segoe UI"\/><a:cs typeface="Segoe UI"\/><\/a:rPr><a:t>passed<\/a:t>/);
    expect(await part(made.path, 'ppt/slides/_rels/slide5.xml.rels')).toContain('../media/image5.png');
    const chart = await part(made.path, 'ppt/slides/slide6.xml');
    expect(chart).toContain('<a:t>$31</a:t>');
    expect(chart).toContain('<a:t>Actual</a:t>');
    expect(await part(made.path, 'ppt/slides/slide7.xml')).toContain('<a:t>-40%</a:t>');
    expect(await part(made.path, 'ppt/theme/theme1.xml')).toContain('<a:accent1><a:srgbClr val="FF8800"/>');
    await allXmlWellFormed(made.path);
  });

  it('refuses a chart slide without data', async () => {
    setup();
    const r = await run('create.presentation', { title: 'T', slides: [{ layout: 'chart', title: 'x' }] });
    expect('rejected' in r && r.rejected).toMatch(/without chart data/);
  });
});

describe('Excel workbooks', () => {
  it('makes an .xlsx with a styled frozen header, formats, formulas and widths', async () => {
    setup();
    const made = ok(
      await run('create.spreadsheet', {
        title: 'Budget 2026',
        currency: '€',
        sheets: [
          {
            name: 'Budget',
            columns: [{ header: 'Item' }, { header: 'Cost', format: 'currency' }, { header: 'Due', format: 'date' }, { header: 'Share', format: 'percent', width: 10 }],
            rows: [
              ['Rent', 1200, '2026-11-01', '=B2/B4'],
              ['Food', 400.5, '2026-11-05', '=B3/B4'],
              ['Total', '=SUM(B2:B3)', null, null],
            ],
            totalsRow: true,
          },
          { name: 'Notes', rows: [['Plain sheet', true]] },
        ],
      }),
    );
    expect(made.details.formulas).toBe(3);
    const sheet = await part(made.path, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<c r="A1" s="14" t="inlineStr"><is><t xml:space="preserve">Item</t></is></c>');
    expect(sheet).toContain('<c r="B2" s="3"><v>1200</v></c>');
    expect(sheet).toContain(`<c r="C2" s="5"><v>${excelDate('2026-11-01')}</v></c>`);
    expect(sheet).toContain('<c r="D2" s="4"><f>B2/B4</f></c>');
    expect(sheet).toContain('<c r="B4" s="10"><f>SUM(B2:B3)</f></c>');
    expect(sheet).toContain('<col min="4" max="4" width="10.0" customWidth="1"/>');
    const book = await part(made.path, 'xl/workbook.xml');
    expect(book).toContain('<sheet name="Budget" sheetId="1" r:id="rId1"/>');
    expect(book).toContain('fullCalcOnLoad="1"');
    const styles = await part(made.path, 'xl/styles.xml');
    expect(styles).toContain('formatCode="&quot;€&quot;#,##0.00"');
    expect(styles.match(/<xf /g)?.length).toBe(1 + 15);
    expect(await part(made.path, 'xl/worksheets/sheet2.xml')).toContain('t="b"><v>1</v>');
    await allXmlWellFormed(made.path);
    expect(excelDate('1900-03-01')).toBe(61);
    expect([colName(0), colName(25), colName(26), colName(701)]).toEqual(['A', 'Z', 'AA', 'ZZ']);
  });

  it('refuses formulas that reach outside the workbook and duplicate sheet names', async () => {
    setup();
    const web = await run('create.spreadsheet', { title: 'x', sheets: [{ name: 'S', rows: [['=WEBSERVICE("http://x")']] }] });
    expect('rejected' in web && web.rejected).toMatch(/outside the workbook/);
    const dde = await run('create.spreadsheet', { title: 'x', sheets: [{ name: 'S', rows: [["=cmd|' /C calc'!A0"]] }] });
    expect('rejected' in dde && dde.rejected).toMatch(/outside the workbook/);
    const dup = await run('create.spreadsheet', { title: 'x', sheets: [{ name: 'S', rows: [] }, { name: 's', rows: [] }] });
    expect('rejected' in dup && dup.rejected).toMatch(/different name/);
  });
});

const GAME = `<!doctype html><html><head><meta charset="utf-8"><title>Asteroids</title><style>body{margin:0;background:#000}</style></head>
<body><canvas id="c" width="800" height="600"></canvas><svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>
<script>const c=document.getElementById('c'),g=c.getContext('2d');let x=400,boost=0;
addEventListener('keydown',e=>{if(e.key==='ArrowLeft')x-=10;if(e.key==='ArrowRight')x+=10;if(e.code==='Space')boost=1;});
function loop(){g.fillStyle='#000';g.fillRect(0,0,800,600);g.fillStyle='#0ff';g.fillRect(x,500,20,20);requestAnimationFrame(loop)}loop();</script></body></html>`;

describe('web games and apps', () => {
  it('saves a self-contained page with a network-blocking policy and opens it', async () => {
    const { opened } = setup();
    expect(pageProblems(GAME)).toEqual([]);
    const made = ok(await run('create.web_app', { title: 'Asteroid Dodge', html: GAME }));
    expect(made.fileName).toBe('Asteroid Dodge.html');
    const html = fs.readFileSync(made.path, 'utf8');
    expect(html).toContain(`<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none';`);
    expect(html).toContain("connect-src 'none'");
    // No remote URL anywhere except the SVG namespace name.
    expect([...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0])).toEqual(['http://www.w3.org/2000/svg']);
    const op = await run('create.open', { path: made.path });
    expect(tier(op)).toBe('important');
    ok(op);
    expect(opened).toEqual([made.path]);
  });

  it('refuses pages that load or send anything', async () => {
    setup();
    const cases: Array<[string, RegExp]> = [
      [GAME.replace('<script>', '<script src="https://cdn.example.com/three.js"></script><script>'), /external script/],
      [GAME.replace('loop();', 'loop();fetch("/score");'), /fetch/],
      [GAME.replace('loop();', 'loop();new WebSocket("wss://x.io");'), /network connection|remote URL/],
      [GAME.replace('<style>', '<link rel="stylesheet" href="x.css"><style>'), /linked file/],
      [GAME.replace('background:#000', 'background:url(https://img.example.com/a.png)'), /remote URL/],
      [GAME.replace('</body>', '<iframe src="about:blank"></iframe></body>'), /frame/],
      [GAME.replace('loop();', 'loop();import("./x.js");'), /dynamic import/],
    ];
    for (const [html, why] of cases) expect(pageProblems(html).join('; ')).toMatch(why);
    const r = await run('create.web_app', { title: 'Bad', html: cases[0]![0] });
    expect('rejected' in r && r.rejected).toMatch(/not self-contained/);
  });

  it('adds a head when the page has none', () => {
    const page = withPolicy('<canvas></canvas><script>1</script>', 'A <b> game');
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('Content-Security-Policy');
    expect(page).toContain('<title>A b game</title>');
  });
});

/** Triangle count and bounding box of a binary STL. */
function readStl(file: string) {
  const b = fs.readFileSync(file);
  const n = b.readUInt32LE(80);
  expect(b.length).toBe(84 + n * 50);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++)
    for (let v = 1; v <= 3; v++)
      for (let k = 0; k < 3; k++) {
        const x = b.readFloatLE(84 + t * 50 + v * 12 + k * 4);
        min[k] = Math.min(min[k]!, x);
        max[k] = Math.max(max[k]!, x);
      }
  return { n, min, max, header: b.toString('ascii', 0, 80) };
}

const vol = async (spec: unknown) => (await buildModel(ModelSpec.parse({ name: 't', model: spec, placeOnBed: false }))).volume;

describe('3D-printable models', () => {
  it('builds primitives with the right volume and outward faces', async () => {
    expect(await vol({ shape: 'cube', size: 10 })).toBeCloseTo(1000, 6);
    expect(await vol({ shape: 'cube', size: [10, 20, 5] })).toBeCloseTo(1000, 6);
    // Polygon approximations sit just under the true volume.
    const cyl = await vol({ shape: 'cylinder', radius: 5, height: 10, segments: 64 });
    expect(cyl).toBeGreaterThan(Math.PI * 250 * 0.99);
    expect(cyl).toBeLessThan(Math.PI * 250);
    expect(await vol({ shape: 'cone', radius: 5, height: 9, segments: 64 })).toBeCloseTo(cyl * 0.3, 0);
    const sph = await vol({ shape: 'sphere', radius: 10, segments: 64 });
    expect(sph).toBeGreaterThan(((4 / 3) * Math.PI * 1000) * 0.98);
    expect(sph).toBeLessThan((4 / 3) * Math.PI * 1000);
    expect(cube([1, 1, 1])).toHaveLength(6);
    expect(cylinder(1, 1, 0, 8)).toHaveLength(9);
    expect(sphere(1, 8).length).toBeGreaterThan(20);
  });

  it('subtracts, unites and intersects solids', async () => {
    // A 20 mm cube with a 4 mm hole straight through it.
    const hole = await vol({ op: 'difference', children: [{ shape: 'cube', size: 20 }, { shape: 'cylinder', radius: 4, height: 30, segments: 64 }] });
    const holeArea = 0.5 * 64 * 16 * Math.sin((2 * Math.PI) / 64);
    expect(hole).toBeCloseTo(8000 - holeArea * 20, 3);
    // Two overlapping cubes: 1000 + 1000 − 500 (shared half).
    expect(await vol({ op: 'union', children: [{ shape: 'cube', size: 10 }, { shape: 'cube', size: 10, translate: [5, 0, 0] }] })).toBeCloseTo(1500, 4);
    expect(await vol({ op: 'intersection', children: [{ shape: 'cube', size: 10 }, { shape: 'cube', size: 10, translate: [5, 0, 0] }] })).toBeCloseTo(500, 4);
    // Apart: union keeps both, intersection is empty.
    expect(await vol({ op: 'union', children: [{ shape: 'cube', size: 10 }, { shape: 'cube', size: 10, translate: [50, 0, 0] }] })).toBeCloseTo(2000, 6);
    await expect(vol({ op: 'intersection', children: [{ shape: 'cube', size: 10 }, { shape: 'cube', size: 10, translate: [50, 0, 0] }] })).rejects.toThrow(/empty/);
    // Turned 45° about Z, a 10 mm cube is 14.1 mm across.
    const m = await buildModel(ModelSpec.parse({ name: 't', model: { shape: 'cube', size: 10, rotate: [0, 0, 45] } }));
    expect(m.size[0]).toBeCloseTo(10 * Math.SQRT2, 4);
    expect(m.min[2]).toBeCloseTo(0, 9);
  });

  it('makes a rocket STL sitting on the bed and reports its size in mm', async () => {
    setup();
    // A fin beside the body, turned around the rocket's axis by a union with rotate.
    const fin = (deg: number) => ({ op: 'union', rotate: [0, 0, deg], children: [{ shape: 'cube', size: [2, 14, 16], translate: [0, 12, -12] }] });
    const made = ok(
      await run('create.model', {
        name: 'Rocket',
        model: {
          op: 'difference',
          children: [
            {
              op: 'union',
              children: [
                { shape: 'cylinder', radius: 8, height: 50, segments: 48 },
                { shape: 'cone', radius: 8, height: 20, translate: [0, 0, 35], segments: 48 },
                fin(0),
                fin(120),
                fin(240),
              ],
            },
            { shape: 'cylinder', radius: 3, height: 10, translate: [0, 0, -22], segments: 32 },
          ],
        },
      }),
    );
    expect(made.fileName).toBe('Rocket.stl');
    const stl = readStl(made.path);
    expect(stl.header.startsWith('Keo STL: Rocket')).toBe(true);
    expect(stl.n).toBe(made.details.triangles);
    expect(stl.min[2]).toBeCloseTo(0, 4);
    expect(stl.max[2]).toBeCloseTo(70, 3); // body 50 + nose 20 (fins sit within)
    const size = made.details.sizeMm as { x: number; y: number; z: number };
    expect(size.z).toBe(70);
    // Fins reach 19 mm from the axis (2 mm thick): 19 mm along +y; at 120° and 240° about 17 mm along ±x and 10.4 mm along −y.
    expect(size.y).toBeCloseTo(29.4, 0);
    expect(size.x).toBeCloseTo(33.9, 0);
    expect(made.details.volumeCm3).toBeGreaterThan(10);
    // Centred on x/y.
    expect(Math.abs((stl.min[0]! + stl.max[0]!) / 2)).toBeLessThan(0.01);
    expect(Math.abs((stl.min[1]! + stl.max[1]!) / 2)).toBeLessThan(0.01);
  });

  it('explains exactly which part of a model is wrong', async () => {
    expect(solidProblem({ shape: 'cube', size: 10 })).toBeNull();
    expect(solidProblem({ op: 'union', children: [{ shape: 'cube', size: 10 }, { shape: 'sphere' }] })).toMatch(/^model\.children\.1\.radius: /);
    expect(solidProblem({ op: 'union', children: [{ shape: 'pyramid', size: 1 }] })).toMatch(/^model\.children\.0\.shape/);
    expect(solidProblem({ shape: 'cylinder', radius: 2, height: 3, segments: 500 })).toMatch(/^model\.segments/);
    expect(solidProblem([1])).toMatch(/must be an object/);
    setup();
    const r = await run('create.model', { name: 'x', model: { op: 'difference', children: [{ shape: 'cube', size: -1 }] } });
    expect('rejected' in r && r.rejected).toMatch(/children\.0\.size/);
  });

  it('writes valid binary STL and refuses oversized models', async () => {
    const mesh = await buildModel(ModelSpec.parse({ name: 'c', model: { shape: 'cube', size: 10 } }));
    const b = toStl(mesh, 'Cubé');
    expect(b.readUInt32LE(80)).toBe(12);
    expect(b.toString('ascii', 0, 13)).toBe('Keo STL: Cub?');
    // The first triangle's normal is a unit vector.
    expect(Math.hypot(b.readFloatLE(84), b.readFloatLE(88), b.readFloatLE(92))).toBeCloseTo(1, 5);
    setup();
    const many = { op: 'union', children: Array.from({ length: 40 }, () => ({ op: 'union', children: Array.from({ length: 6 }, () => ({ shape: 'cube', size: 1 })) })) };
    const r = await run('create.model', { name: 'x', model: many });
    expect('rejected' in r && r.rejected).toMatch(/limit is 200/);
  });
});

describe('tool schemas', () => {
  it('are plain JSON schemas every provider accepts (no recursive $ref)', () => {
    setup();
    const specs = h.services.registry.toolSpecs().filter((t) => t.name.startsWith('create__'));
    expect(specs.map((t) => t.name).sort()).toEqual(['create__document', 'create__get_spec', 'create__model', 'create__open', 'create__presentation', 'create__recent', 'create__spreadsheet', 'create__web_app']);
    for (const t of specs) {
      const text = JSON.stringify(t.inputSchema);
      expect(text).not.toContain('$ref');
      expect(text).not.toContain('$defs');
      expect(t.inputSchema.type).toBe('object');
    }
    expect(JSON.stringify(jsonSchema(ModelSpec))).toContain('"model"');
  });
});

describe('where files go, replacing and editing', () => {
  it('saves in a folder the user named, and refuses one they did not', async () => {
    const { home } = setup();
    const desk = path.join(home, 'Desktop');
    fs.mkdirSync(desk);
    const spec = { title: 'Plan', blocks: [{ type: 'paragraph', text: 'x' }], folder: desk };
    const notNamed = await run('create.document', spec);
    expect('rejected' in notNamed).toBe(false);
    if (!('rejected' in notNamed)) expect(notNamed.step.error).toMatch(/folder the user named/);
    const conv = h.services.conversations.create('files');
    h.services.conversations.addMessage({ conversationId: conv.id, role: 'user', content: 'Make the plan and put it on my Desktop', status: 'complete' });
    expect(ok(await run('create.document', spec, conv.id)).path).toBe(path.join(desk, 'Plan.docx'));
    const outside = await run('create.document', { ...spec, folder: tmp('keo-elsewhere-') });
    expect('rejected' in outside && outside.rejected).toMatch(/outside the folders/);
  });

  it('replaces a file Keo made only with approval, keeping a backup; edits go through its spec', async () => {
    const { out } = setup();
    const made = ok(await run('create.spreadsheet', { title: 'Tracker', sheets: [{ name: 'S', rows: [['old']] }] }));
    const recent = ok<{ files: Array<{ path: string; kind: string; exists: boolean }> }>(await run('create.recent', {}));
    expect(recent.files[0]).toMatchObject({ path: made.path, kind: 'spreadsheet', exists: true });
    const got = ok<{ spec: { title: string; sheets: Array<{ rows: unknown[][] }> } }>(await run('create.get_spec', { path: made.path }));
    expect(got.spec.sheets[0]!.rows).toEqual([['old']]);
    got.spec.sheets[0]!.rows = [['new']];
    const r = await run('create.spreadsheet', { ...got.spec, replace: made.path });
    expect(tier(r)).toBe('always_ask');
    const again = ok(r);
    expect(again.replaced).toBe(true);
    expect(again.path).toBe(made.path);
    expect(fs.readdirSync(out)).toEqual(['Tracker.xlsx']);
    expect(await part(made.path, 'xl/worksheets/sheet1.xml')).toContain('>new<');
    const backups = fs.readdirSync(path.join(h.dir, 'created-backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/Tracker\.xlsx$/);

    // Not a file Keo made, or the wrong kind: refused.
    const stranger = path.join(out, 'Mine.xlsx');
    fs.writeFileSync(stranger, 'x');
    const r2 = await run('create.spreadsheet', { title: 'x', sheets: [{ name: 'S', rows: [] }], replace: stranger });
    expect('rejected' in r2 && r2.rejected).toMatch(/only files it made/);
    const r3 = await run('create.document', { title: 'x', blocks: [{ type: 'page_break' }], replace: made.path });
    expect('rejected' in r3 && r3.rejected).toMatch(/is a Excel workbook|is a Excel|not a Word/);
    const r4 = await run('create.open', { path: stranger });
    expect('rejected' in r4 && r4.rejected).toMatch(/only files it made/);
  });

  it('keeps file names Windows accepts and reads picture sizes', () => {
    expect(safeFileName('Q3: plan / draft?', '.docx')).toBe('Q3 plan draft.docx');
    expect(safeFileName('con', '.xlsx')).toBe('con file.xlsx');
    expect(safeFileName('   ...', '.stl')).toBe('Untitled.stl');
    expect(safeFileName('Deck.pptx', '.pptx')).toBe('Deck.pptx');
    expect(imageInfo(png(3, 2))).toEqual({ ext: 'png', width: 3, height: 2 });
    const gif = Buffer.from('GIF89a\x05\x00\x07\x00', 'latin1');
    expect(imageInfo(Buffer.concat([gif, Buffer.alloc(4)]))).toEqual({ ext: 'gif', width: 5, height: 7 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 50, 0, 80, 3, 0, 0, 0, 0]);
    expect(imageInfo(jpeg)).toEqual({ ext: 'jpeg', width: 80, height: 50 });
  });
});
