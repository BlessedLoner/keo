/**
 * Green-screen (chroma key) removal on the graphics card: a small WebGL shader turns the chosen
 * colour transparent (by its hue, so shadows on the screen go too), softens the edge, and takes
 * the coloured glow off the subject's edges. Used by the picture engine for preview and export.
 */

export interface ChromaOptions {
  /** The colour to remove, #RRGGBB. */
  color: string;
  /** How close a colour must be to go (0..1). */
  similarity: number;
  /** How soft the edge is (0..1). */
  smoothness: number;
  /** How much of the colour's glow is taken off the subject (0..1). */
  spill: number;
}

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D tex;
uniform vec3 key;
uniform float similarity;
uniform float smoothness;
uniform float spill;
out vec4 outColor;
vec2 chroma(vec3 c) { return vec2(-0.1687 * c.r - 0.3313 * c.g + 0.5 * c.b, 0.5 * c.r - 0.4187 * c.g - 0.0813 * c.b); }
void main() {
  vec4 src = texture(tex, uv);
  float d = distance(chroma(src.rgb), chroma(key));
  float a = smoothstep(similarity, similarity + smoothness, d);
  float s = pow(clamp(1.0 - smoothstep(similarity, similarity + spill * 0.5 + 0.001, d), 0.0, 1.0), 1.5) * spill;
  vec3 grey = vec3(dot(src.rgb, vec3(0.2126, 0.7152, 0.0722)));
  vec3 rgb = mix(src.rgb, grey, s);
  outColor = vec4(rgb * a * src.a, a * src.a);
}`;

type Keyer = { canvas: HTMLCanvasElement | OffscreenCanvas; gl: WebGL2RenderingContext; prog: WebGLProgram; tex: WebGLTexture; loc: Record<string, WebGLUniformLocation | null> };
let keyer: Keyer | null | undefined;

function make(): Keyer | null {
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) return null;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const loc = Object.fromEntries(['tex', 'key', 'similarity', 'smoothness', 'spill'].map((n) => [n, gl.getUniformLocation(prog, n)]));
    return { canvas, gl, prog, tex, loc };
  } catch {
    return null;
  }
}

/**
 * The source with the key colour made transparent, as a canvas of w×h (drawn right away by the
 * caller: the canvas is reused for the next clip). null: this PC has no WebGL 2.
 */
export function chromaKey(src: CanvasImageSource, w: number, h: number, o: ChromaOptions): HTMLCanvasElement | OffscreenCanvas | null {
  if (keyer === undefined) keyer = make();
  if (!keyer) return null;
  const { canvas, gl, loc } = keyer;
  // Never more than 1920 pixels across: keying is per pixel.
  const k = Math.min(1, 1920 / Math.max(w, h));
  const cw = Math.max(2, Math.round(w * k));
  const ch = Math.max(2, Math.round(h * k));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  gl.viewport(0, 0, cw, ch);
  gl.bindTexture(gl.TEXTURE_2D, keyer.tex);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
  } catch {
    return null;
  }
  const hex = o.color.replace('#', '');
  gl.uniform3f(loc.key!, parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
  gl.uniform1f(loc.similarity!, 0.02 + o.similarity * 0.3);
  gl.uniform1f(loc.smoothness!, 0.005 + o.smoothness * 0.2);
  gl.uniform1f(loc.spill!, o.spill);
  gl.uniform1i(loc.tex!, 0);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}
