import { desktopCapturer, nativeImage } from 'electron';
import { isBlank } from './blank';
import type { CaptureOutcome, ImageTools, WindowCaptureSource } from './visionService';

/**
 * Captures one window through Electron's desktopCapturer (Windows Graphics
 * Capture / DWM). Only a source whose id matches the requested HWND is used;
 * if it is absent, empty or blank the capture fails — there is no full-screen
 * fallback.
 */
export class ElectronWindowCapture implements WindowCaptureSource {
  async capture(hwnd: string): Promise<CaptureOutcome> {
    if (process.platform !== 'win32') return { ok: false, code: 'unsupported', message: 'Window capture is implemented for Windows only.' };
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 2560, height: 2560 }, fetchWindowIcons: false });
    const src = sources.find((s) => s.id.startsWith(`window:${hwnd}:`));
    if (!src) return { ok: false, code: 'source_not_found', message: 'Windows did not offer a capture source for this window (it may be protected, cloaked or closed).' };
    const img = src.thumbnail;
    if (img.isEmpty()) return { ok: false, code: 'empty_capture', message: 'The capture returned no image data.' };
    const { width, height } = img.getSize();
    if (width < 8 || height < 8) return { ok: false, code: 'empty_capture', message: 'The captured image is too small to be meaningful.' };
    if (isBlank(img.toBitmap(), width, height)) {
      return { ok: false, code: 'blank_capture', message: 'The capture is a single flat colour, which usually means the window content is protected or not rendered.' };
    }
    return { ok: true, png: img.toPNG(), width, height };
  }
}

export const electronImageTools: ImageTools = {
  fit(png, maxSide) {
    const img = nativeImage.createFromBuffer(png);
    const { width, height } = img.getSize();
    const scale = Math.min(1, maxSide / Math.max(width, height));
    if (scale >= 1) return png;
    return img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }).toPNG();
  },
};
