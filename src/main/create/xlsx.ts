import type { SheetSpec, WorkbookSpec } from './specs';
import { appProps, coreProps, esc, OFFICE_DOC_REL, PACKAGE_RELS, writeZip, XML_HEAD } from './zip';

/**
 * Excel workbooks: sheets with a styled header row, number formats per column, formulas (Excel
 * calculates them when the file opens), fitted or chosen column widths and a frozen header.
 */

const FORMATS = ['general', 'integer', 'number', 'currency', 'percent', 'date', 'text'] as const;
type Format = (typeof FORMATS)[number];

/** Functions that reach outside the workbook (web requests, other programs, DDE): never written. */
const OUTSIDE = /\b(WEBSERVICE|FILTERXML|CALL|REGISTER|REGISTER\.ID|EXEC|RTD|HYPERLINK|IMAGE|DDE|DDEAUTO)\s*\(|\|/i;

export function unsafeFormula(spec: WorkbookSpec): string | null {
  for (const s of spec.sheets) {
    const text = new Set(s.columns?.map((c, i) => (c.format === 'text' ? i : -1)) ?? []);
    for (const row of s.rows) {
      for (const [i, v] of row.entries()) {
        if (typeof v === 'string' && v.startsWith('=') && !text.has(i) && OUTSIDE.test(v)) return `${s.name}: ${v.slice(0, 60)}`;
      }
    }
  }
  return null;
}

export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Days since 30 December 1899 (Excel's date numbers) for "YYYY-MM-DD", or null. */
export function excelDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  return Number.isNaN(t) ? null : (t - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** Index into cellXfs (see styles()): the column's format, plain (0–6) or as a totals row (7–13). */
const style = (f: Format, total: boolean) => (total ? FORMATS.length : 0) + FORMATS.indexOf(f);
const HEADER_STYLE = FORMATS.length * 2;

function sheetXml(s: SheetSpec, first: boolean): string {
  const cols = s.columns ?? [];
  const width = Math.max(cols.length, ...s.rows.map((r) => r.length), 1);
  const fmt = (i: number): Format => cols[i]?.format ?? 'general';
  const rows: string[] = [];
  const lens = Array.from({ length: width }, (_, i) => (cols[i]?.header.length ?? 0) + 2);
  let r = 1;
  if (cols.length) {
    rows.push(`<row r="1" ht="22" customHeight="1">${cols.map((c, i) => `<c r="${colName(i)}1" s="${HEADER_STYLE}" t="inlineStr"><is><t xml:space="preserve">${esc(c.header)}</t></is></c>`).join('')}</row>`);
    r = 2;
  }
  s.rows.forEach((row, ri) => {
    const total = s.totalsRow && ri === s.rows.length - 1;
    const cells: string[] = [];
    row.forEach((v, i) => {
      if (v === null || v === '') return;
      const ref = `${colName(i)}${r}`;
      const f = fmt(i);
      let st = style(f, total);
      if (typeof v === 'number') {
        cells.push(`<c r="${ref}" s="${st}"><v>${v}</v></c>`);
        lens[i] = Math.max(lens[i]!, String(+v.toFixed(2)).length + (f === 'currency' ? 4 : 2));
      } else if (typeof v === 'boolean') {
        cells.push(`<c r="${ref}" s="${st}" t="b"><v>${v ? 1 : 0}</v></c>`);
      } else if (v.startsWith('=') && f !== 'text') {
        cells.push(`<c r="${ref}" s="${st}"><f>${esc(v.slice(1))}</f></c>`);
        lens[i] = Math.max(lens[i]!, 12);
      } else if (f === 'date' && excelDate(v) !== null) {
        cells.push(`<c r="${ref}" s="${st}"><v>${excelDate(v)}</v></c>`);
        lens[i] = Math.max(lens[i]!, 12);
      } else {
        // Text in a number column keeps the column's look but stays text.
        if (f !== 'text') st = style('general', total);
        cells.push(`<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`);
        lens[i] = Math.max(lens[i]!, Math.min(60, Math.max(...v.split('\n').map((l) => l.length))) + 2);
      }
    });
    rows.push(`<row r="${r}">${cells.join('')}</row>`);
    r++;
  });
  const colXml = Array.from({ length: width }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${(cols[i]?.width ?? Math.min(62, Math.max(8, lens[i]!))).toFixed(1)}" customWidth="1"/>`).join('');
  const freeze = s.freezeHeader && cols.length ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '';
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ''}>${freeze}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${colXml}</cols><sheetData>${rows.join('')}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
}

function styles(spec: WorkbookSpec): string {
  const head = spec.headerColor ?? '1F3864';
  const cur = esc(`"${spec.currency}"#,##0.00`);
  // In FORMATS order: plain cells, the same bold with a line above (totals row), then the header (HEADER_STYLE).
  const ids = [0, 3, 4, 164, 10, 165, 49];
  const xf = (numFmt: number, font: number, border: number, extra = '') =>
    `<xf numFmtId="${numFmt}" fontId="${font}" fillId="0" borderId="${border}" xfId="0"${numFmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${border ? ' applyBorder="1"' : ''}${extra}/>`;
  const plain = [xf(0, 0, 0), ...ids.slice(1).map((n) => xf(n, 0, 0))];
  const totals = ids.map((n) => xf(n, 2, 1));
  const header = `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>`;
  const all = [...plain, ...totals, header];
  return `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="${cur}"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${head}"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color auto="1"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${all.length}">${all.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

export function buildXlsx(spec: WorkbookSpec, now = new Date()): Buffer {
  const bad = unsafeFormula(spec);
  if (bad) throw new Error(`Formulas that reach outside the workbook are not allowed (${bad}).`);
  const n = spec.sheets.length;
  const ct = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${spec.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const workbook = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${spec.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const rels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${spec.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  return writeZip([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: PACKAGE_RELS('xl/workbook.xml', OFFICE_DOC_REL) },
    { name: 'docProps/core.xml', data: coreProps(spec.title, now) },
    { name: 'docProps/app.xml', data: appProps('Keo') },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/styles.xml', data: styles(spec) },
    ...spec.sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, i === 0) })),
  ]);
}
