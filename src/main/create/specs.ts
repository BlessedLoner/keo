import { z } from 'zod';

/**
 * What the model may ask Keo to make. Every spec is plain data with size limits; Keo turns it into
 * a file itself (no code from the model runs, except inside the HTML page the user asked for,
 * which runs in their browser with network access switched off).
 */

const Text = (max: number) => z.string().max(max);
const Hex = z
  .string()
  .trim()
  .regex(/^#?[0-9a-fA-F]{6}$/, 'A colour like "#1E3A8A".')
  .transform((s) => s.replace('#', '').toUpperCase());
const ImagePath = z.string().trim().min(4).max(500).describe('Full path of a PNG, JPEG or GIF picture on this computer (e.g. one found with files__search).');

// ---------- Word ----------

const Inline = Text(4000).describe('Text; **bold** and *italic* are allowed inside it.');
export const DocBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: Text(300), level: z.number().int().min(1).max(3).default(1) }).strict(),
  z.object({ type: z.literal('paragraph'), text: Inline, align: z.enum(['left', 'center', 'right', 'justify']).optional() }).strict(),
  z.object({ type: z.literal('bullets'), items: z.array(Inline).min(1).max(100), ordered: z.boolean().default(false) }).strict(),
  z
    .object({
      type: z.literal('table'),
      header: z.array(Text(200)).min(1).max(12).optional(),
      rows: z.array(z.array(Text(1000)).max(12)).max(300),
    })
    .strict(),
  z.object({ type: z.literal('page_break') }).strict(),
  z.object({ type: z.literal('image'), path: ImagePath, widthCm: z.number().min(1).max(17).optional(), caption: Text(300).optional() }).strict(),
]);
export type DocBlock = z.infer<typeof DocBlock>;

export const DocSpec = z
  .object({
    title: Text(200).describe('Shown as the document’s title at the top and in its properties.'),
    subtitle: Text(300).optional(),
    font: z.enum(['Calibri', 'Aptos', 'Arial', 'Georgia', 'Cambria', 'Times New Roman', 'Segoe UI']).default('Calibri'),
    blocks: z.array(DocBlock).min(1).max(600),
  })
  .strict();
export type DocSpec = z.infer<typeof DocSpec>;

// ---------- PowerPoint ----------

export const THEMES = ['midnight', 'ocean', 'sunset', 'forest', 'paper', 'coral', 'mono'] as const;

const Series = z.object({ name: Text(60), values: z.array(z.number().finite()).min(1).max(12) }).strict();
export const SlideSpec = z
  .object({
    layout: z.enum(['title', 'section', 'bullets', 'two_column', 'image', 'chart', 'quote', 'closing']).default('bullets'),
    title: Text(200),
    subtitle: Text(400).optional().describe('title / section / closing slides; the attribution on a quote slide.'),
    bullets: z.array(Text(400)).max(10).optional().describe('bullets, image (beside the picture) and chart slides; the left column of two_column.'),
    right: z.array(Text(400)).max(10).optional().describe('two_column: the right column.'),
    leftHeading: Text(80).optional(),
    rightHeading: Text(80).optional(),
    image: ImagePath.optional().describe('image slides.'),
    chart: z
      .object({ kind: z.enum(['column', 'bar']).default('column'), labels: z.array(Text(40)).min(1).max(12), series: z.array(Series).min(1).max(3), unit: Text(12).optional() })
      .strict()
      .optional()
      .describe('chart slides: a simple chart drawn with shapes.'),
    quote: Text(500).optional().describe('quote slides.'),
    background: Hex.optional().describe('Override the theme background for this slide.'),
  })
  .strict();
export type SlideSpec = z.infer<typeof SlideSpec>;

export const DeckSpec = z
  .object({
    title: Text(200),
    theme: z.enum(THEMES).default('midnight').describe('midnight (dark blue, cyan accent), ocean (deep teal), sunset (warm dark, orange), forest (green), paper (light, navy), coral (light, coral), mono (black and white).'),
    accent: Hex.optional().describe('Replace the theme’s accent colour.'),
    background: Hex.optional().describe('Replace the theme’s background colour.'),
    font: z.enum(['Segoe UI', 'Calibri', 'Aptos', 'Arial', 'Georgia', 'Trebuchet MS', 'Verdana']).optional(),
    slideNumbers: z.boolean().default(true),
    slides: z.array(SlideSpec).min(1).max(60),
  })
  .strict();
export type DeckSpec = z.infer<typeof DeckSpec>;

// ---------- Excel ----------

const Cell = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]).describe('A value; text starting with "=" is a formula, e.g. "=SUM(B2:B9)".');
export const SheetSpec = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(31)
      .regex(/^[^\\/?*[\]:]+$/, 'Sheet names cannot contain \\ / ? * [ ] :'),
    columns: z
      .array(
        z
          .object({
            header: Text(100),
            width: z.number().min(3).max(120).optional().describe('In characters; omitted = fitted to the contents.'),
            format: z.enum(['general', 'text', 'integer', 'number', 'currency', 'percent', 'date']).default('general'),
          })
          .strict(),
      )
      .max(50)
      .optional()
      .describe('One per column: the header row (bold, coloured) and the column’s number format.'),
    rows: z.array(z.array(Cell).max(50)).max(5000),
    freezeHeader: z.boolean().default(true),
    totalsRow: z.boolean().default(false).describe('Make the last row bold with a line above it.'),
  })
  .strict();
export type SheetSpec = z.infer<typeof SheetSpec>;

export const WorkbookSpec = z
  .object({
    title: Text(200),
    headerColor: Hex.optional().describe('Header row fill; default dark blue.'),
    currency: z.enum(['$', '€', '£', '¥', '₹', 'R', '₦', 'KSh']).default('$'),
    sheets: z.array(SheetSpec).min(1).max(20).describe('Different names; with columns, row 1 is the header and data starts on row 2 (use that in formulas).'),
  })
  .strict();
export type WorkbookSpec = z.infer<typeof WorkbookSpec>;

// ---------- 3D model ----------

const Vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const Transform = {
  translate: Vec3.optional().describe('Move by [x, y, z] mm.'),
  rotate: Vec3.optional().describe('Turn by [x, y, z] degrees (about X, then Y, then Z).'),
  scale: z.union([z.number().min(0.01).max(100), z.tuple([z.number().min(0.01).max(100), z.number().min(0.01).max(100), z.number().min(0.01).max(100)])]).optional(),
};
const Segments = z.number().int().min(6).max(64).optional().describe('Smoothness of round parts (default 48).');
const Mm = z.number().min(0.05).max(2000);

export type SolidNode =
  | { shape: 'cube'; size: number | [number, number, number]; translate?: [number, number, number]; rotate?: [number, number, number]; scale?: number | [number, number, number] }
  | { shape: 'sphere'; radius: number; segments?: number; translate?: [number, number, number]; rotate?: [number, number, number]; scale?: number | [number, number, number] }
  | { shape: 'cylinder'; radius: number; height: number; radiusTop?: number; segments?: number; translate?: [number, number, number]; rotate?: [number, number, number]; scale?: number | [number, number, number] }
  | { shape: 'cone'; radius: number; height: number; segments?: number; translate?: [number, number, number]; rotate?: [number, number, number]; scale?: number | [number, number, number] }
  | { op: 'union' | 'difference' | 'intersection'; children: SolidNode[]; translate?: [number, number, number]; rotate?: [number, number, number]; scale?: number | [number, number, number] };

const Shape = z.discriminatedUnion('shape', [
  z.object({ shape: z.literal('cube'), size: z.union([Mm, z.tuple([Mm, Mm, Mm])]), ...Transform }).strict(),
  z.object({ shape: z.literal('sphere'), radius: Mm, segments: Segments, ...Transform }).strict(),
  z.object({ shape: z.literal('cylinder'), radius: Mm, height: Mm, radiusTop: z.number().min(0).max(2000).optional(), segments: Segments, ...Transform }).strict(),
  z.object({ shape: z.literal('cone'), radius: Mm, height: Mm, segments: Segments, ...Transform }).strict(),
]);
const Op = z.object({ op: z.enum(['union', 'difference', 'intersection']), children: z.array(z.unknown()).min(1).max(40), ...Transform }).strict();

/** The first problem in a model tree, with where it is (e.g. "children.2.radius: …"), or null. */
export function solidProblem(v: unknown, at = 'model', depth = 0): string | null {
  if (depth > 30) return `${at}: nested too deeply.`;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at}: each part must be an object with "shape" or "op".`;
  const r = 'op' in v ? Op.safeParse(v) : Shape.safeParse(v);
  if (!r.success) {
    const i = r.error.issues[0]!;
    return `${[at, ...i.path].join('.')}: ${i.message}`;
  }
  if ('op' in v) {
    const kids = (v as unknown as { children: unknown[] }).children;
    for (let k = 0; k < kids.length; k++) {
      const p = solidProblem(kids[k], `${at}.children.${k}`, depth + 1);
      if (p) return p;
    }
  }
  return null;
}

/**
 * Checked as a tree here, but shown to the model as a plain object (described in the tool's text):
 * a recursive JSON schema ($ref) is refused by some providers, which would break every tool call.
 */
export const SolidNode = z
  .record(z.string(), z.unknown())
  .superRefine((v, ctx) => {
    const p = solidProblem(v);
    if (p) ctx.addIssue({ code: 'custom', message: p });
  })
  .describe('One part: { shape: "cube", size } | { shape: "sphere", radius } | { shape: "cylinder", radius, height, radiusTop? } | { shape: "cone", radius, height }, or { op: "union" | "difference" | "intersection", children: [parts] }; any part may have translate, rotate, scale; round parts may have segments (6–64, default 48).') as unknown as z.ZodType<SolidNode>;

export const ModelSpec = z
  .object({
    name: Text(120),
    model: SolidNode,
    placeOnBed: z.boolean().default(true).describe('Move the finished model so it sits on z = 0, centred on x/y (ready to slice).'),
  })
  .strict();
export type ModelSpec = z.infer<typeof ModelSpec>;

// ---------- Web page ----------

export const PageSpec = z
  .object({
    title: Text(120),
    html: z.string().min(50).max(400_000).describe('One complete HTML document with all CSS and JavaScript inline. No external scripts, styles, fonts, images or network requests; pictures and sounds as data: URLs or drawn in code.'),
  })
  .strict();
export type PageSpec = z.infer<typeof PageSpec>;
