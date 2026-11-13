/**
 * Pro colour grading on the graphics card: tint, highlights, shadows, whites, blacks, fade, sharpen,
 * HSL per colour range, a tone curve and an imported LUT. The picture engine hands a picture in and
 * draws the graded copy, so the preview and the export look the same. Exposure, contrast,
 * saturation, temperature and vignette stay where they were (plain picture filters), so older
 * projects look exactly as before.
 */
import { HSL_RANGES, proGrade, type ColorGrade } from '@shared/studio';
import { curveTable, parseCube, type Lut } from '@shared/studioLut';
import { invoke } from '../lib/api';

type Source = CanvasImageSource & { readonly displayWidth?: number; readonly displayHeight?: number };

const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D img;
uniform sampler2D curveTex;
uniform sampler3D lutTex;
uniform vec2 texel;
uniform float tint, highlights, shadows, whites, blacks, sharpen, fade;
uniform float useCurve, useLut, lutSize, lutAmount;
uniform vec3 bands[8];
in vec2 uv;
out vec4 o;
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
const float CENTRES[8] = float[8](0.0, 0.0833, 0.1667, 0.3333, 0.5, 0.625, 0.75, 0.875);
void main() {
  vec4 src = texture(img, uv);
  vec3 col = src.rgb;
  if (sharpen > 0.0) {
    vec3 blur = (texture(img, uv + vec2(texel.x, 0.0)).rgb + texture(img, uv - vec2(texel.x, 0.0)).rgb + texture(img, uv + vec2(0.0, texel.y)).rgb + texture(img, uv - vec2(0.0, texel.y)).rgb) * 0.25;
    col += (col - blur) * sharpen * 1.6;
  }
  float l = dot(clamp(col, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722));
  float sw = 1.0 - smoothstep(0.0, 0.55, l);
  float hw = smoothstep(0.45, 1.0, l);
  col *= 1.0 + shadows * 0.6 * sw;
  col += (highlights >= 0.0 ? (1.0 - col) * highlights * 0.5 : col * highlights * 0.35) * hw;
  float bp = -blacks * 0.12;
  float wp = 1.0 - whites * 0.18;
  col = (col - bp) / max(0.05, wp - bp);
  col += vec3(tint * 0.04, -tint * 0.07, tint * 0.04);
  col = col * (1.0 - fade * 0.16) + fade * 0.1;
  col = clamp(col, 0.0, 1.0);
  vec3 hsv = rgb2hsv(col);
  vec3 change = vec3(0.0);
  float weight = 0.0;
  for (int i = 0; i < 8; i++) {
    float d = abs(hsv.x - CENTRES[i]);
    d = min(d, 1.0 - d);
    float w = clamp(1.0 - d / 0.09, 0.0, 1.0);
    change += bands[i] * w;
    weight += w;
  }
  if (weight > 0.0) {
    change *= hsv.y > 0.05 ? 1.0 : hsv.y / 0.05;
    hsv.x = fract(hsv.x + change.x * 0.083 + 1.0);
    hsv.y = clamp(hsv.y * (1.0 + change.y), 0.0, 1.0);
    hsv.z = clamp(hsv.z * (1.0 + change.z * 0.5), 0.0, 1.0);
    col = hsv2rgb(hsv);
  }
  if (useCurve > 0.5) col = vec3(texture(curveTex, vec2(col.r, 0.5)).r, texture(curveTex, vec2(col.g, 0.5)).r, texture(curveTex, vec2(col.b, 0.5)).r);
  if (useLut > 0.5) {
    vec3 at = col * ((lutSize - 1.0) / lutSize) + 0.5 / lutSize;
    col = mix(col, texture(lutTex, at).rgb, lutAmount);
  }
  o = vec4(col * src.a, src.a);
}`;

interface Gl {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  img: WebGLTexture;
  curve: WebGLTexture;
  lut: WebGLTexture;
  u: Record<string, WebGLUniformLocation | null>;
  curveKey: string;
  lutKey: string;
}

let state: Gl | null | undefined;

function setup(): Gl | null {
  if (state !== undefined) return state;
  try {
    const canvas = new OffscreenCanvas(16, 16);
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return (state = null);
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = (unit: number, target: number) => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, t);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      return t;
    };
    const img = tex(0, gl.TEXTURE_2D);
    const curve = tex(1, gl.TEXTURE_2D);
    const lut = tex(2, gl.TEXTURE_3D);
    const u: Gl['u'] = {};
    for (const n of ['img', 'curveTex', 'lutTex', 'texel', 'tint', 'highlights', 'shadows', 'whites', 'blacks', 'sharpen', 'fade', 'useCurve', 'useLut', 'lutSize', 'lutAmount', 'bands']) u[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(u.img!, 0);
    gl.uniform1i(u.curveTex!, 1);
    gl.uniform1i(u.lutTex!, 2);
    return (state = { canvas, gl, prog, img, curve, lut, u, curveKey: '', lutKey: '' });
  } catch {
    return (state = null);
  }
}

// ---------------------------------------------------------------- LUTs the user imported

const luts = new Map<string, Lut | 'loading' | 'failed'>();

async function loadLut(name: string): Promise<void> {
  if (luts.has(name)) return;
  luts.set(name, 'loading');
  try {
    const r = await invoke('studio:lut', { name });
    luts.set(name, parseCube(r.text));
  } catch {
    luts.set(name, 'failed');
  }
}

/** Every LUT a project's clips use, read before an export starts (so no frame is drawn without it). */
export async function prepareLuts(grades: Array<ColorGrade | undefined | null>): Promise<void> {
  const names = new Set(grades.flatMap((g) => (g?.lut ? [g.lut.name] : [])));
  await Promise.all([...names].map((n) => loadLut(n)));
}

/** A LUT that was just imported or replaced is read again. */
export function forgetLut(name: string): void {
  luts.delete(name);
}

// ---------------------------------------------------------------- grading

/**
 * The graded copy of a picture (at most 2560 pixels on its long side), or null when nothing needs
 * the graphics card or it is not available (then the picture is drawn as it is). The copy is only
 * good until the next call: draw it straight away.
 */
export function gradePicture(src: Source, w: number, h: number, g: ColorGrade | undefined | null): OffscreenCanvas | null {
  if (!proGrade(g) || w < 2 || h < 2) return null;
  const s = setup();
  if (!s) return null;
  const { gl, u } = s;
  const k = Math.min(1, 2560 / Math.max(w, h));
  const cw = Math.max(2, Math.round(w * k));
  const ch = Math.max(2, Math.round(h * k));
  if (s.canvas.width !== cw || s.canvas.height !== ch) {
    s.canvas.width = cw;
    s.canvas.height = ch;
  }
  gl.viewport(0, 0, cw, ch);
  try {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.img);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
  } catch {
    return null;
  }
  const grade = g!;
  gl.uniform2f(u.texel!, 1 / cw, 1 / ch);
  gl.uniform1f(u.tint!, grade.tint ?? 0);
  gl.uniform1f(u.highlights!, grade.highlights ?? 0);
  gl.uniform1f(u.shadows!, grade.shadows ?? 0);
  gl.uniform1f(u.whites!, grade.whites ?? 0);
  gl.uniform1f(u.blacks!, grade.blacks ?? 0);
  gl.uniform1f(u.sharpen!, grade.sharpen ?? 0);
  gl.uniform1f(u.fade!, grade.fade ?? 0);
  const bands = new Float32Array(24);
  HSL_RANGES.forEach((r, i) => {
    const b = grade.hsl?.[r];
    bands[i * 3] = b?.hue ?? 0;
    bands[i * 3 + 1] = b?.sat ?? 0;
    bands[i * 3 + 2] = b?.lum ?? 0;
  });
  gl.uniform3fv(u.bands!, bands);
  // The tone curve, as a 256-level strip (made again only when it changes).
  const curveKey = grade.curve ? JSON.stringify(grade.curve) : '';
  if (curveKey && curveKey !== s.curveKey) {
    const table = curveTable(grade.curve!);
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = Math.round(table[i]! * 255);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, s.curve);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    s.curveKey = curveKey;
  }
  gl.uniform1f(u.useCurve!, curveKey ? 1 : 0);
  // The LUT, once it has been read (until then the rest of the grade is drawn without it).
  let useLut = 0;
  if (grade.lut && grade.lut.amount > 0) {
    const lut = luts.get(grade.lut.name);
    if (!lut) void loadLut(grade.lut.name);
    else if (typeof lut === 'object') {
      if (s.lutKey !== grade.lut.name) {
        const bytes = new Uint8Array(lut.data.length);
        for (let i = 0; i < lut.data.length; i++) bytes[i] = Math.round(lut.data[i]! * 255);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_3D, s.lut);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, lut.size, lut.size, lut.size, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes);
        s.lutKey = grade.lut.name;
      }
      useLut = 1;
      gl.uniform1f(u.lutSize!, lut.size);
      gl.uniform1f(u.lutAmount!, grade.lut.amount);
    }
  }
  gl.uniform1f(u.useLut!, useLut);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return s.canvas;
}
