import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lastError, probe, type FfmpegRunner } from "../video/ffmpeg";
import { safeFileName, uniquePath, writeAtomic } from "../create/output";
import { buildAnimation, type AnimateSpec } from "./animate";
import { buildEditGraph, type EditOp } from "./edit";

/**
 * Keo's pictures: edits and animations made with ffmpeg on the user's PC, and (optionally) new or
 * AI-changed pictures from the user's OpenAI account. Every result is a new file in Documents\Keo
 * (or a folder the user named); the source picture is never changed.
 */
export interface PictureAi {
  /** A new picture from a description; PNG bytes. */
  generate(
    o: {
      prompt: string;
      size: string;
      quality: string;
      background: "auto" | "transparent" | "opaque";
    },
    signal: AbortSignal,
  ): Promise<Buffer>;
  /** Changes a picture as described (or makes its background transparent); PNG bytes. */
  edit(
    o: {
      image: Buffer;
      name: string;
      prompt: string;
      size: string;
      quality: string;
      background: "auto" | "transparent" | "opaque";
    },
    signal: AbortSignal,
  ): Promise<Buffer>;
}

export interface PictureStudioDeps {
  runner(): FfmpegRunner | null;
  /** Documents\Keo. */
  outputRoot(): string;
  fontsDir: string;
  /** Keo's own temporary folder for renders. */
  workRoot: string;
  /** The user's OpenAI image access, when a key is saved (checked each time). */
  ai(): PictureAi | null;
  /** The picture as PNG through another decoder (the app: Chromium's), for files ffmpeg cannot read; null if it cannot either. */
  normalize?(file: string): Promise<Buffer | null>;
}

export class PictureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const PICTURE = /\.(png|jpe?g|jfif|webp|bmp|gif|tiff?)$/i;

export class PictureStudio {
  constructor(private readonly d: PictureStudioDeps) {}

  private tools(): FfmpegRunner {
    const r = this.d.runner();
    if (!r)
      throw new PictureError(
        "no_ffmpeg",
        "Editing pictures uses ffmpeg, which is not set up yet. The user can choose Settings → Video → Set up video tools (one click).",
      );
    return r;
  }

  private checkSource(file: string): void {
    if (!PICTURE.test(file))
      throw new PictureError(
        "not_picture",
        `${path.basename(file)} is not a picture Keo can edit (PNG, JPEG, WebP, BMP, GIF or TIFF).`,
      );
    if (!fs.existsSync(file))
      throw new PictureError(
        "not_found",
        `${path.basename(file)} was not found. Find it again with files__search.`,
      );
  }

  private work(): string {
    const dir = path.join(
      this.d.workRoot,
      `pic-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private target(name: string, ext: string, folder?: string): string {
    const dir = folder ?? this.d.outputRoot();
    fs.mkdirSync(dir, { recursive: true });
    return uniquePath(dir, safeFileName(name, ext));
  }

  /**
   * Runs `fn` with the source; if ffmpeg cannot read it (an unusual JPEG, a mislabelled file), once
   * more with a PNG copy made by the other decoder.
   */
  private async withReadable<T>(
    source: string,
    dir: string,
    signal: AbortSignal,
    fn: (src: string, size: { width: number; height: number }) => Promise<T>,
  ): Promise<T> {
    const r = this.tools();
    const attempt = async (src: string) => {
      const info = await probe(r, src, signal);
      if (!info.width || !info.height)
        throw new PictureError(
          "not_picture",
          `ffmpeg could not read the size of ${path.basename(source)}.`,
        );
      return fn(src, { width: info.width, height: info.height });
    };
    try {
      return await attempt(source);
    } catch (e) {
      if (signal.aborted || !this.d.normalize) throw e;
      const png = await this.d.normalize(source).catch(() => null);
      if (!png) throw e;
      const copy = path.join(dir, "source.png");
      fs.writeFileSync(copy, png);
      return attempt(copy);
    }
  }

  async edit(
    source: string,
    ops: EditOp[],
    o: { name: string; format: "png" | "jpg"; folder?: string },
    signal: AbortSignal,
  ): Promise<{ path: string; width: number; height: number }> {
    this.checkSource(source);
    for (const op of ops) if (op.op === "overlay") this.checkSource(op.image);
    const r = this.tools();
    const dir = this.work();
    try {
      return await this.withReadable(source, dir, signal, async (src, info) => {
        const g = buildEditGraph(
          ops,
          { width: info.width, height: info.height },
          { fontsDir: this.d.fontsDir, workDir: dir },
        );
        for (const t of g.texts) fs.writeFileSync(t.file, t.text, "utf8");
        const tmp = path.join(dir, `out.${o.format}`);
        const args = [
          "-y",
          "-hide_banner",
          "-i",
          src,
          ...g.inputs.flatMap((p) => ["-i", p]),
          "-filter_complex",
          g.graph,
          "-map",
          "[out]",
          "-frames:v",
          "1",
          "-update",
          "1",
          ...(o.format === "jpg" ? ["-q:v", "2"] : []),
          tmp,
        ];
        const res = await r.ffmpeg(args, {
          signal,
          cwd: dir,
          timeoutMs: 120_000,
        });
        if (res.code !== 0 || !fs.existsSync(tmp))
          throw new PictureError(
            "render_failed",
            `ffmpeg could not make the picture: ${lastError(res.stderr)}`,
          );
        const out = this.target(o.name, `.${o.format}`, o.folder);
        writeAtomic(out, fs.readFileSync(tmp));
        return { path: out, ...g.size };
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async animate(
    source: string,
    spec: AnimateSpec,
    o: { name: string; folder?: string },
    signal: AbortSignal,
  ): Promise<{
    path: string;
    width: number;
    height: number;
    seconds: number;
    format: "mp4" | "gif";
  }> {
    this.checkSource(source);
    const r = this.tools();
    const dir = this.work();
    try {
      return await this.withReadable(source, dir, signal, async (src, info) => {
        const tmp = path.join(dir, `out.${spec.format}`);
        const b = buildAnimation(src, info, spec, tmp, {
          fontsDir: this.d.fontsDir,
          workDir: dir,
        });
        for (const t of b.texts) fs.writeFileSync(t.file, t.text, "utf8");
        const res = await r.ffmpeg(b.args, {
          signal,
          cwd: dir,
          timeoutMs: 300_000,
        });
        if (res.code !== 0 || !fs.existsSync(tmp))
          throw new PictureError(
            "render_failed",
            `ffmpeg could not make the animation: ${lastError(res.stderr)}`,
          );
        const out = this.target(o.name, `.${spec.format}`, o.folder);
        writeAtomic(out, fs.readFileSync(tmp));
        return {
          path: out,
          ...b.size,
          seconds: spec.seconds,
          format: spec.format,
        };
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  aiAvailable(): boolean {
    return !!this.d.ai();
  }

  async generate(
    prompt: string,
    o: {
      name: string;
      size: string;
      quality: string;
      background: "auto" | "transparent" | "opaque";
      folder?: string;
    },
    signal: AbortSignal,
  ): Promise<{ path: string }> {
    const ai = this.d.ai();
    if (!ai)
      throw new PictureError(
        "no_ai",
        "Making pictures needs an OpenAI API key (Settings → Providers → OpenAI).",
      );
    const png = await ai.generate(
      { prompt, size: o.size, quality: o.quality, background: o.background },
      signal,
    );
    const out = this.target(o.name, ".png", o.folder);
    writeAtomic(out, png);
    return { path: out };
  }

  async aiEdit(
    source: string,
    prompt: string,
    o: {
      name: string;
      size: string;
      quality: string;
      background: "auto" | "transparent" | "opaque";
      folder?: string;
    },
    signal: AbortSignal,
  ): Promise<{ path: string }> {
    const ai = this.d.ai();
    if (!ai)
      throw new PictureError(
        "no_ai",
        "Changing pictures with AI needs an OpenAI API key (Settings → Providers → OpenAI).",
      );
    this.checkSource(source);
    const bytes = fs.readFileSync(source);
    if (bytes.length > 25 * 1024 * 1024)
      throw new PictureError("too_large", "That picture is larger than 25 MB.");
    const png = await ai.edit(
      {
        image: bytes,
        name: path.basename(source),
        prompt,
        size: o.size,
        quality: o.quality,
        background: o.background,
      },
      signal,
    );
    const out = this.target(o.name, ".png", o.folder);
    writeAtomic(out, png);
    return { path: out };
  }
}
