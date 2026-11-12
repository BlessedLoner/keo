import type { SceneState, SceneStep, VisualScene } from '../../src/shared/scene';

export interface ViewerInfo {
  step: number;
  steps: number;
  title: string;
  say: string;
  playing: boolean;
  done: boolean;
  /** 0–1 through the current step. */
  progress: number;
}

export interface ViewerOptions {
  /** Drag to turn, wheel to zoom (default true). */
  controls?: boolean;
  labels?: boolean;
  onChange?: (info: ViewerInfo) => void;
  /** A step begins. A promise handed back (the narration) is waited for before the next step. */
  onStep?: (index: number, step: SceneStep) => Promise<unknown> | void;
  /** The bytes of a realistic model (.glb) by its saved name, for objects of shape "model". */
  loadModel?: (name: string) => Promise<ArrayBuffer>;
  /** No animation loop: the picture is drawn only when asked (snapshot, seek). */
  still?: boolean;
  /** With still: keep the step's focus (labels) instead of showing everything plainly. */
  dim?: boolean;
  quality?: 'high' | 'fast';
}

export class SceneViewer {
  constructor(container: HTMLElement, scene: VisualScene, states: SceneState[], opts?: ViewerOptions);
  readonly stepCount: number;
  info(): ViewerInfo;
  play(): void;
  pause(): void;
  goTo(step: number): void;
  resetView(): void;
  /** Draws the exact moment `seconds` into the whole explanation (optionally at a size) and gives back the canvas. */
  seek(seconds: number, width?: number, height?: number): HTMLCanvasElement;
  labelPoints(): Array<{ text: string; x: number; y: number }>;
  readonly canvas: HTMLCanvasElement;
  snapshot(type?: string, quality?: number): string;
  dispose(): void;
}

/** A still picture (PNG data URL) of a scene's opening view. */
export function sceneThumbnail(scene: VisualScene, states: SceneState[], width?: number, height?: number, opts?: ViewerOptions): string;
