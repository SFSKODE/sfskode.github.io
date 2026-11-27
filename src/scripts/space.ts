// Space backdrop for the dark theme: a real-time black hole with gravitational lensing and an accretion disk, a layered
// drifting starfield, and the occasional shooting star. All of it is procedural (no image files). The shader runs only
// while the dark theme is on and the tab is visible, adapts its resolution to the device, and renders one still frame
// for visitors who prefer reduced motion. Without WebGL the CSS fallback in space.css stays visible.
import { reduced } from './util';

const root = document.documentElement;
const host = document.querySelector<HTMLElement>('[data-space]');
const canvas = document.querySelector<HTMLCanvasElement>('[data-space-canvas]');
const meteors = document.querySelector<HTMLElement>('[data-space-meteors]');

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes;      // canvas size in pixels
uniform float uTime;    // seconds
uniform vec2 uHole;     // black hole centre, 0..1 (y up)
uniform float uR;       // shadow radius in pixels
uniform vec2 uPar;      // parallax offset for the stars
uniform float uDim;     // 1 at the top of the page, lower further down
uniform float uCalm;    // overall brightness of the hole and disk (lower on small screens, where text covers the whole width)

float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }

// One layer of stars: a star in some grid cells, with its own size, colour and twinkle.
vec3 stars(vec2 uv, float density, float size, float seed, float t){
  vec2 g = uv * density, id = floor(g), f = fract(g) - 0.5;
  float h = h21(id + seed);
  if (h < 0.80) return vec3(0.0);
  vec2 off = (vec2(h21(id + seed + 3.1), h21(id + seed + 7.7)) - 0.5) * 0.7;
  float mag = pow(h21(id + seed + 9.3), 3.0);
  float tw = 0.78 + 0.22 * sin(t * (0.8 + 2.6 * h21(id + seed + 1.9)) + h * 40.0);
  float s = smoothstep(size * (0.55 + 0.9 * mag), 0.0, length(f - off)) * (0.22 + 0.95 * mag) * tw;
  vec3 c = mix(vec3(0.68, 0.8, 1.0), vec3(1.0, 0.86, 0.7), h21(id + seed + 5.5));
  return c * s;
}

// Everything that sits "behind" the black hole: the sky colour, a faint galaxy band, nebula and the stars.
vec3 sky(vec2 uv, float t){
  vec3 col = mix(vec3(0.004, 0.008, 0.028), vec3(0.012, 0.016, 0.05), clamp(uv.y * 0.6 + 0.5, 0.0, 1.0));
  vec2 b = vec2(uv.x * 0.8 + uv.y * 0.6, uv.y * 0.8 - uv.x * 0.6);          // a diagonal band, like our own galaxy
  float band = exp(-b.y * b.y * 5.0);
  float cloud = fbm(uv * 2.4 + vec2(t * 0.004, 0.0));
  col += band * (0.012 + 0.07 * cloud * cloud) * mix(vec3(0.35, 0.42, 1.0), vec3(1.0, 0.55, 0.45), noise(uv * 1.6 + 5.0));
  col += 0.025 * pow(fbm(uv * 1.3 + 31.0), 2.0) * vec3(0.3, 0.5, 1.0);
  float drift = t * 0.0035;                                                  // the whole sky turns very slowly
  col += stars(uv * 1.0 + vec2(drift, 0.0) + uPar * 0.5, 34.0, 0.060, 1.0, t) * 0.8;
  col += stars(uv * 1.3 + vec2(drift * 1.8, 0.0) + uPar * 1.0, 22.0, 0.070, 11.0, t) * 1.0;
  col += stars(uv * 1.7 + vec2(drift * 3.0, 0.0) + uPar * 1.8, 12.0, 0.085, 23.0, t) * 1.25;
  return col;
}

vec3 diskColour(float rho, float heat){            // hot white-yellow inside, orange, then deep red outside
  vec3 hot = vec3(1.0, 0.93, 0.78), mid = vec3(1.0, 0.55, 0.2), cold = vec3(0.55, 0.12, 0.05);
  vec3 c = mix(hot, mid, smoothstep(2.0, 3.4, rho));
  c = mix(c, cold, smoothstep(3.2, 6.0, rho));
  return c * heat;
}

void main(){
  vec2 frag = gl_FragCoord.xy;
  float m = min(uRes.x, uRes.y);
  vec2 uv = (frag - 0.5 * uRes) / m;                                          // sky coordinates (1 = shorter side)
  vec2 pos = (frag - uHole * uRes) / uR;                                      // black hole coordinates (1 = shadow radius)
  float tilt = -0.42;                                                         // the disk is tilted a little, diagonally
  mat2 rot = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt));
  vec2 p = rot * pos;
  float r = length(p);

  // Gravitational lensing: the sky behind the hole is bent into an Einstein ring (thin-lens approximation).
  float te2 = 2.6;
  vec2 q = p - te2 * p / (dot(p, p) + 0.02);
  vec2 bend = q * rot;                                             // back to screen orientation
  vec2 skyUv = (uHole * uRes - 0.5 * uRes) / m + bend * uR / m;
  float mag = clamp(1.0 / abs(1.0 - te2 * te2 / (r * r * r * r + 0.03)), 0.0, 3.5);
  vec3 col = sky(mix(uv, skyUv, smoothstep(9.0, 3.0, r)), uTime) * (1.0 + 0.6 * mag * smoothstep(5.0, 1.2, r));

  // The shadow: nothing escapes from inside, so the sky is cut away.
  float shadow = smoothstep(0.96, 1.04, r);
  col *= shadow;

  // The accretion disk seen almost edge on. "rho" is the radius in the disk plane, the disk is flattened by sin(inclination).
  float incl = 0.19;
  vec2 d = vec2(p.x, p.y / incl);
  float rho = length(d);
  float ang = atan(d.y, d.x);
  float omega = 2.6 / pow(rho, 1.5);                                          // inner gas orbits faster (Kepler)
  float tex = fbm(vec2(rho * 2.4, (ang + uTime * omega * 0.9) * 2.2 + rho));
  float fine = noise(vec2(rho * 9.0, (ang + uTime * omega) * 6.0));
  float band = smoothstep(1.9, 2.3, rho) * exp(-(rho - 2.0) * 0.62) * smoothstep(7.5, 4.6, rho);
  float doppler = pow(clamp(1.0 + 0.75 * (-d.x / max(rho, 0.001)), 0.15, 2.2), 2.4);   // the side coming towards us is brighter
  float heat = band * (0.5 + 1.1 * tex) * (0.78 + 0.5 * fine) * doppler * 1.5;
  vec3 disk = diskColour(rho, heat);
  float inFront = step(p.y, 0.0);                                             // the near half passes in front of the hole
  col += disk * mix(shadow, 1.0, inFront);

  // The far half of the disk, bent over the top and bottom of the hole by its gravity, plus the thin photon ring.
  float arc = exp(-(r - 1.0) * 1.7) * (0.3 + 0.7 * pow(abs(p.y) / max(r, 0.001), 2.0)) * smoothstep(0.98, 1.1, r);
  float arcTex = 0.7 + 0.6 * fbm(vec2(atan(p.y, p.x) * 3.0 + uTime * 0.35, r * 5.0));
  col += vec3(1.0, 0.72, 0.42) * arc * arcTex * (0.55 + 0.35 * doppler) * 2.1;
  col += vec3(1.0, 0.92, 0.82) * exp(-pow((r - 1.045) / 0.03, 2.0)) * 0.9;
  col += vec3(1.0, 0.55, 0.25) * exp(-r * 0.55) * 0.07 * smoothstep(0.9, 1.4, r);      // a faint glow around everything

  // Keep the page readable: the further we scroll, the calmer the picture.
  col *= mix(1.0, 0.62, 1.0 - uDim);
  col = mix(sky(uv, uTime), col, uCalm);                                      // on small screens fade the black hole into plain sky
  col = 1.0 - exp(-col * 1.25);                                                // soft tone mapping
  col += (h21(frag + uTime) - 0.5) / 255.0;                                   // dithering, no banding in the dark gradients
  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error');
  return s;
}

function startShader(cv: HTMLCanvasElement, wrap: HTMLElement) {
  const gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) return false;
  let prog: WebGLProgram;
  try {
    prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link error');
  } catch (e) { console.warn('[space] WebGL backdrop disabled:', e); return false; }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n: string) => gl.getUniformLocation(prog, n);
  const uRes = U('uRes'), uTime = U('uTime'), uHole = U('uHole'), uR = U('uR'), uPar = U('uPar'), uDim = U('uDim'), uCalm = U('uCalm');

  const small = matchMedia('(max-width: 700px)').matches;
  let quality = small ? 0.55 : 0.85;                 // fraction of CSS pixels we render; adapts to the device below
  let w = 0, h = 0, holeX = 0.78, holeY = 0.78, radius = 100;
  let mouseX = 0, mouseY = 0, dim = 1, scrollY = 0;
  let running = false, raf = 0, t0 = performance.now() - Math.random() * 60000, last = 0, slow = 0, frames = 0;

  function resize() {
    const cw = wrap.clientWidth || innerWidth, ch = wrap.clientHeight || innerHeight;
    w = Math.max(2, Math.round(cw * quality)); h = Math.max(2, Math.round(ch * quality));
    cv.width = w; cv.height = h;
    gl!.viewport(0, 0, w, h);
    const portrait = ch > cw;
    holeX = portrait ? 0.9 : 0.865; holeY = portrait ? 0.95 : 0.815;   // top-right corner (y is up in GL)
    radius = (portrait ? 0.055 * ch : 0.047 * Math.max(cw, ch * 1.6)) * quality;
  }

  function draw(now: number) {
    const t = reduced() ? 40 : (now - t0) / 1000;
    gl!.uniform2f(uRes, w, h);
    gl!.uniform1f(uTime, t);
    gl!.uniform2f(uHole, holeX, holeY + Math.min(scrollY, 900) / 900 * 0.03);
    gl!.uniform1f(uR, radius);
    gl!.uniform2f(uPar, mouseX * 0.012 + scrollY * 0.00002, mouseY * 0.012 - scrollY * 0.00005);
    gl!.uniform1f(uDim, dim);
    gl!.uniform1f(uCalm, small ? 0.62 : 1.0);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }

  function frame(now: number) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (now - last < 30) return;                      // about 30 frames a second is plenty for slow motion
    const dt = now - last; last = now;
    draw(now);
    // If frames are slow, render fewer pixels. The picture is soft anyway, so nobody notices.
    frames += 1;
    if (frames > 20 && dt > 52) slow += 1; else if (dt < 40) slow = Math.max(0, slow - 1);
    if (slow > 12 && quality > 0.4) { quality = Math.max(0.4, quality - 0.15); slow = 0; frames = 0; resize(); }
  }

  const start = () => { if (running || reduced()) return; running = true; last = 0; raf = requestAnimationFrame(frame); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  const active = () => root.getAttribute('data-theme') === 'dark' && !document.hidden;
  const sync = () => {
    if (root.getAttribute('data-theme') !== 'dark') { stop(); return; }
    resize(); draw(performance.now());
    if (active()) start(); else stop();
  };

  addEventListener('resize', () => { if (root.getAttribute('data-theme') === 'dark') { resize(); draw(performance.now()); } }, { passive: true });
  addEventListener('scroll', () => {
    scrollY = window.scrollY;
    dim = Math.max(0.0, 1 - Math.min(1, scrollY / (innerHeight * 1.4)));
  }, { passive: true });
  addEventListener('pointermove', (e) => { mouseX = e.clientX / innerWidth - 0.5; mouseY = e.clientY / innerHeight - 0.5; }, { passive: true });
  document.addEventListener('visibilitychange', () => (active() ? start() : stop()));
  addEventListener('themechange', sync);
  cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); wrap.classList.remove('is-live'); });
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  sync();
  wrap.classList.add('is-live');
  return true;
}

function startMeteors(layer: HTMLElement) {
  if (reduced()) return;
  const spawn = () => {
    if (root.getAttribute('data-theme') === 'dark' && !document.hidden) {
      const m = document.createElement('i');
      m.className = 'meteor';
      const angle = 20 + Math.random() * 18;           // degrees below horizontal, heading left-down like a real meteor shower
      const len = 260 + Math.random() * 260;
      m.style.left = `${35 + Math.random() * 65}vw`;
      m.style.top = `${Math.random() * 45}vh`;
      m.style.rotate = `${180 - angle}deg`;
      m.style.setProperty('--dx', `${-Math.cos((angle * Math.PI) / 180) * len}px`);
      m.style.setProperty('--dy', `${Math.sin((angle * Math.PI) / 180) * len}px`);
      m.style.width = `${90 + Math.random() * 90}px`;
      layer.appendChild(m);
      m.addEventListener('animationend', () => m.remove(), { once: true });
    }
    window.setTimeout(spawn, 5000 + Math.random() * 9000);
  };
  window.setTimeout(spawn, 2500);
}

if (host && canvas) {
  const ok = startShader(canvas, host);
  if (!ok) host.classList.remove('is-live');
  if (meteors) startMeteors(meteors);
}
