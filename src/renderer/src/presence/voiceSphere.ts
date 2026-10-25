/**
 * Keo's voice sphere: thousands of fine points on a sphere whose surface ripples with 3D noise,
 * lit from the rim like the reference design. How strongly it ripples comes from `energy()`
 * (the real voice level while listening or speaking, a slow pulse while thinking); `tint()` gives
 * the state colour. WebGL when available, otherwise a lighter 2D canvas version.
 */
export interface SphereInputs {
  /** 0..1 — how strongly the surface moves now. */
  energy(): number;
  /** RGB 0..1 of the light on the rim. */
  tint(): [number, number, number];
  /** -1..1 — where the mouse is, for a slight turn toward it. */
  pointer(): [number, number];
}

const N = 22000;

// 3D simplex noise: Ian McEwan, Ashima Arts (MIT licence), as published in webgl-noise.
const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const VERT = `
precision highp float;
attribute vec3 aPos;
uniform float uTime, uEnergy, uAspect, uScale, uPx;
uniform mat3 uRot;
varying float vLight;
varying float vFront;
${NOISE}
float field(vec3 n){
  float t = uTime;
  return snoise(n * 1.05 + vec3(0.0, t * 0.18, t * 0.1)) * 0.7
       + snoise(n * 2.4 - vec3(t * 0.3)) * 0.3 * (0.5 + uEnergy);
}
vec3 surf(vec3 n){
  return n * (1.0 + field(n) * (0.12 + uEnergy * 0.28));
}
void main(){
  vec3 n = uRot * aPos;
  vec3 p0 = surf(n);
  // The rippled surface's own normal, from two nearby points on it.
  vec3 a = normalize(cross(n, abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(n, a);
  float e = 0.035;
  vec3 p1 = surf(normalize(n + a * e));
  vec3 p2 = surf(normalize(n + b * e));
  vec3 N = normalize(cross(p1 - p0, p2 - p0));
  if (dot(N, n) < 0.0) N = -N;
  float camera = 3.4;
  float z = camera - p0.z;
  vec2 xy = p0.xy * (camera / z);
  gl_Position = vec4(xy.x * uScale / uAspect, xy.y * uScale, 0.0, 1.0);
  vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
  vec3 V = vec3(0.0, 0.0, 1.0);
  float diff = max(0.0, dot(N, L));
  float spec = pow(max(0.0, dot(reflect(-L, N), V)), 22.0);
  float rim = pow(1.0 - max(0.0, N.z), 3.0);
  vLight = 0.13 + diff * 0.72 + spec * 0.7 + rim * 0.34 + uEnergy * 0.3 * diff;
  vFront = smoothstep(-0.12, 0.08, n.z);
  gl_PointSize = (1.7 + spec * 1.1 + uEnergy * 0.5) * uPx;
}`;

const FRAG = `
precision mediump float;
uniform vec3 uTint;
varying float vLight;
varying float vFront;
void main(){
  if (vFront < 0.02) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float soft = smoothstep(0.5, 0.1, r);
  vec3 base = vec3(0.36, 0.39, 0.45);
  vec3 col = mix(base, uTint, clamp(vLight * 1.1, 0.0, 1.0));
  float a = clamp(vLight, 0.0, 1.0) * soft * vFront;
  gl_FragColor = vec4(col * a, a);
}`;

function fibonacciSphere(n: number): Float32Array {
  const out = new Float32Array(n * 3);
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = g * i;
    out[i * 3] = Math.cos(th) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(th) * r;
  }
  return out;
}

function rotation(ax: number, ay: number): Float32Array {
  const cx = Math.cos(ax);
  const sx = Math.sin(ax);
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  // R = Rx(ax) * Ry(ay), column-major for WebGL
  return new Float32Array([cy, sx * sy, -cx * sy, 0, cx, sx, sy, -sx * cy, cx * cy]);
}

/** Starts drawing into the canvas; returns a function that stops it. */
export function startSphere(canvas: HTMLCanvasElement, input: SphereInputs): () => void {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: true, alpha: true });
  return gl ? startGl(canvas, gl, input) : start2d(canvas, input);
}

function fit(canvas: HTMLCanvasElement): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

function startGl(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, input: SphereInputs): () => void {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  let prog: WebGLProgram;
  try {
    prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
  } catch {
    return start2d(canvas, input);
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, fibonacciSphere(N), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  const u = (n: string) => gl.getUniformLocation(prog, n);
  const uTime = u('uTime');
  const uEnergy = u('uEnergy');
  const uAspect = u('uAspect');
  const uScale = u('uScale');
  const uPx = u('uPx');
  const uRot = u('uRot');
  const uTint = u('uTint');
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let raf = 0;
  let e = 0;
  let tint: [number, number, number] = input.tint();
  let px = 0;
  let py = 0;
  const t0 = performance.now();
  const frame = (now: number) => {
    const dpr = fit(canvas);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const target = input.energy();
    e += (target - e) * (target > e ? 0.35 : 0.08);
    const want = input.tint();
    tint = [tint[0] + (want[0] - tint[0]) * 0.06, tint[1] + (want[1] - tint[1]) * 0.06, tint[2] + (want[2] - tint[2]) * 0.06];
    const [mx, my] = input.pointer();
    px += (mx - px) * 0.04;
    py += (my - py) * 0.04;
    const t = (now - t0) / 1000;
    gl.uniform1f(uTime, t);
    gl.uniform1f(uEnergy, e);
    gl.uniform1f(uAspect, canvas.width / Math.max(1, canvas.height));
    gl.uniform1f(uScale, 0.58 * (1 + e * 0.06));
    gl.uniform1f(uPx, dpr);
    gl.uniformMatrix3fv(uRot, false, rotation(0.32 + py * 0.25 + Math.sin(t * 0.21) * 0.08, t * 0.16 + px * 0.5));
    gl.uniform3f(uTint, tint[0], tint[1], tint[2]);
    gl.drawArrays(gl.POINTS, 0, N);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    gl.deleteBuffer(buf);
    gl.deleteProgram(prog);
  };
}

/** Without WebGL: fewer points, the same idea, drawn with the 2D canvas. */
function start2d(canvas: HTMLCanvasElement, input: SphereInputs): () => void {
  const g = canvas.getContext('2d');
  if (!g) return () => undefined;
  const pts = fibonacciSphere(2600);
  let raf = 0;
  let e = 0;
  const t0 = performance.now();
  const frame = (now: number) => {
    const dpr = fit(canvas);
    const W = canvas.width;
    const H = canvas.height;
    g.clearRect(0, 0, W, H);
    e += (input.energy() - e) * 0.15;
    const t = (now - t0) / 1000;
    const R = Math.min(W, H) * 0.29 * (1 + e * 0.06);
    const [tr, tg, tb] = input.tint();
    const ay = t * 0.16;
    const ax = 0.32;
    for (let i = 0; i < pts.length; i += 1) {
      let x = pts[i * 3]!;
      let y = pts[i * 3 + 1]!;
      let z = pts[i * 3 + 2]!;
      const x1 = x * Math.cos(ay) + z * Math.sin(ay);
      const z1 = -x * Math.sin(ay) + z * Math.cos(ay);
      const y1 = y * Math.cos(ax) - z1 * Math.sin(ax);
      const z2 = y * Math.sin(ax) + z1 * Math.cos(ax);
      x = x1;
      y = y1;
      z = z2;
      const d = Math.sin(x * 3.1 + t * 0.9) * Math.cos(y * 2.7 - t * 0.7) * Math.sin(z * 2.3 + t * 0.5);
      const k = 1 + d * (0.08 + e * 0.3);
      const rim = Math.pow(1 - Math.abs(z), 2.4);
      const a = (0.1 + rim * 0.9) * (z > 0 ? 1 : 0.45);
      const c = (v: number) => Math.round((0.42 + (v - 0.42) * rim) * 255);
      g.fillStyle = `rgba(${c(tr)},${c(tg)},${c(tb)},${a.toFixed(3)})`;
      g.fillRect(W / 2 + x * k * R, H / 2 - y * k * R, (1 + rim) * dpr, (1 + rim) * dpr);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
