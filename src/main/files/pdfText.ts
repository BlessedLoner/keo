import fs from 'node:fs';

/**
 * The text of a PDF with Mozilla's pdf.js (pdfjs-dist, Apache-2.0), in Node: text only — no
 * rendering, no fonts loaded, no scripts, eval off — and only the first pages. A scanned PDF has
 * no text layer, so it comes back (nearly) empty and the caller says so.
 */

interface TextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfPage {
  getTextContent(): Promise<{ items: TextItem[] }>;
  cleanup(): void;
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfJs {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}

// A specifier in a variable: the library is loaded only when a PDF is read, and stays outside the bundle.
const PDFJS = 'pdfjs-dist/legacy/build/pdf.mjs';
let lib: Promise<PdfJs> | null = null;
const load = () =>
  (lib ??= (import(PDFJS) as Promise<PdfJs>).catch(() => {
    lib = null;
    const e = new Error('Reading PDFs is not available in this copy of Keo.');
    e.name = 'PdfUnavailable';
    throw e;
  }));

export async function pdfText(file: string, maxPages: number, signal: AbortSignal): Promise<{ text: string; pages: number; pagesRead: number }> {
  const data = new Uint8Array(await fs.promises.readFile(file));
  const pdfjs = await load();
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 });
  const onAbort = () => void task.destroy().catch(() => undefined);
  signal.addEventListener('abort', onAbort);
  try {
    const doc = await task.promise;
    const pagesRead = Math.min(doc.numPages, maxPages);
    const out: string[] = [];
    for (let n = 1; n <= pagesRead; n++) {
      if (signal.aborted) throw new Error('Stopped.');
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      out.push(
        items
          .map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : ''))
          .join('')
          .replace(/[ \t]+\n/g, '\n')
          .trim(),
      );
    }
    return { text: out.filter(Boolean).join('\n\n'), pages: doc.numPages, pagesRead };
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Let pdf.js finish closing its text streams first: destroying mid-close throws ERR_INVALID_STATE
    // from inside the library, outside any promise Keo could catch.
    await new Promise((r) => setImmediate(r));
    await task.destroy().catch(() => undefined);
  }
}
