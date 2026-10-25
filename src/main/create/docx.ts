import type { ImageInfo } from './images';
import type { DocSpec } from './specs';
import { appProps, coreProps, esc, IMAGE_REL, OFFICE_DOC_REL, PACKAGE_RELS, writeZip, XML_HEAD } from './zip';

/** A picture already read and checked by the caller. */
export interface LoadedImage {
  data: Buffer;
  info: ImageInfo;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const ACCENT = '1F3864';
const HEADING = '2F5496';
/** A4 with 2.54 cm margins: 15.92 cm of text width. */
const TEXT_WIDTH_TWIPS = 11906 - 2 * 1440;
const EMU_PER_CM = 360000;

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

/** **bold**, *italic* and _italic_ inside a line of text. */
export function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|(?<![\p{L}\p{N}])_([^_\s][^_]*)_(?![\p{L}\p{N}])/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true });
    else runs.push({ text: (m[2] ?? m[3])!, italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

function run(r: Run, extra = ''): string {
  const props = `${r.bold ? '<w:b/>' : ''}${r.italic ? '<w:i/>' : ''}${extra}`;
  const lines = r.text.split('\n');
  const body = lines.map((l, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(l)}</w:t>`).join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${body}</w:r>`;
}

const para = (pPr: string, runs: string) => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
const styled = (style: string, text: string) => para(`<w:pStyle w:val="${style}"/>`, inlineRuns(text).map((r) => run(r)).join(''));

export function buildDocx(spec: DocSpec, images: Map<string, LoadedImage>, now = new Date()): Buffer {
  const body: string[] = [];
  const media: Array<{ name: string; data: Buffer; rId: string }> = [];
  const nums: number[] = []; // numIds of ordered lists, each restarting at 1
  let drawingId = 1;

  body.push(styled('Title', spec.title));
  if (spec.subtitle) body.push(styled('Subtitle', spec.subtitle));

  for (const b of spec.blocks) {
    switch (b.type) {
      case 'heading':
        body.push(styled(`Heading${b.level}`, b.text));
        break;
      case 'paragraph':
        body.push(para(b.align ? `<w:jc w:val="${b.align === 'justify' ? 'both' : b.align}"/>` : '', inlineRuns(b.text).map((r) => run(r)).join('')));
        break;
      case 'bullets': {
        let numId = 1;
        if (b.ordered) {
          numId = 2 + nums.length;
          nums.push(numId);
        }
        for (const item of b.items) body.push(para(`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`, inlineRuns(item).map((r) => run(r)).join('')));
        break;
      }
      case 'table':
        body.push(table(b.header, b.rows), para('', ''));
        break;
      case 'page_break':
        body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        break;
      case 'image': {
        const img = images.get(b.path);
        if (!img) throw new Error(`The picture ${b.path} was not loaded.`);
        const n = media.length + 1;
        const rId = `rId${10 + n}`;
        const ext = img.info.ext === 'jpeg' ? 'jpeg' : img.info.ext;
        media.push({ name: `image${n}.${ext}`, data: img.data, rId });
        // Natural size at 96 dpi, no wider than asked or than the page, no taller than 22 cm.
        const natural = (img.info.width / 96) * 2.54;
        let wCm = Math.min(b.widthCm ?? natural, TEXT_WIDTH_TWIPS / 567);
        let hCm = (wCm * img.info.height) / Math.max(1, img.info.width);
        if (hCm > 22) {
          wCm *= 22 / hCm;
          hCm = 22;
        }
        const cx = Math.round(wCm * EMU_PER_CM);
        const cy = Math.round(hCm * EMU_PER_CM);
        const id = drawingId++;
        body.push(
          para(
            '<w:jc w:val="center"/>',
            `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${n}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
          ),
        );
        if (b.caption) body.push(styled('Caption', b.caption));
        break;
      }
    }
  }

  const document = `${XML_HEAD}<w:document ${W}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const rels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${media.map((m) => `<Relationship Id="${m.rId}" Type="${IMAGE_REL}" Target="media/${m.name}"/>`).join('')}</Relationships>`;
  const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

  return writeZip([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: PACKAGE_RELS('word/document.xml', OFFICE_DOC_REL) },
    { name: 'docProps/core.xml', data: coreProps(spec.title, now) },
    { name: 'docProps/app.xml', data: appProps('Keo') },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: rels },
    { name: 'word/styles.xml', data: styles(spec.font) },
    { name: 'word/numbering.xml', data: numbering(nums) },
    ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data })),
  ]);
}

function table(header: string[] | undefined, rows: string[][]): string {
  const cols = Math.max(header?.length ?? 0, ...rows.map((r) => r.length), 1);
  const w = Math.floor(TEXT_WIDTH_TWIPS / cols);
  const cell = (text: string, head: boolean, shade: string | null) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ''}</w:tcPr>${para(
      '<w:spacing w:before="40" w:after="40"/>',
      inlineRuns(text)
        .map((r) => run(head ? { ...r, bold: true } : r, head ? '<w:color w:val="FFFFFF"/>' : ''))
        .join(''),
    )}</w:tc>`;
  const row = (cells: string[], head: boolean, shade: string | null) =>
    `<w:tr>${head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: cols }, (_, i) => cell(cells[i] ?? '', head, shade)).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${w * cols}" w:type="dxa"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${header ? row(header, true, ACCENT) : ''}${rows.map((r, i) => row(r, false, i % 2 ? 'EEF2F8' : null)).join('')}</w:tbl>`;
}

function styles(font: string): string {
  const f = esc(font);
  const heading = (n: number, size: number, before: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${n === 1 ? ACCENT : HEADING}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="262626"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="${HEADING}"/></w:pBdr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="${ACCENT}"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="320"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>${heading(1, 32, 360)}${heading(2, 26, 280)}${heading(3, 23, 200)}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders></w:tblPr></w:style></w:styles>`;
}

function numbering(ordered: number[]): string {
  const lvl = (fmt: string, text: string) =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`;
  return `${XML_HEAD}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>${lvl('bullet', '•')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${lvl('decimal', '%1.')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${ordered.map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('')}</w:numbering>`;
}
