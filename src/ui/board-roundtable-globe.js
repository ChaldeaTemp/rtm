// The roundtable observation globe, turning on its axis.
// The painted globe stays in the scene as the fallback and supplies the atmosphere at the
// rim; this draws the planet's surface over it with WebGL from an equirectangular map that
// scripts/build-globe-map.py derives from the same painting. At spin 0 the surface matches
// the painting, so the switch is invisible.

const MAP_URL = "/ui/scenes/roundtable-globe-map.webp";
const PHI0 = (20 * Math.PI) / 180;           // the painting is seen from 20°N
const SECONDS_PER_TURN = 150;
const FRAME_MS = 1000 / 30;

const VERTEX = `
attribute vec2 a;
varying vec2 v;
void main() { v = a; gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAGMENT = `
precision mediump float;
varying vec2 v;
uniform sampler2D map;
uniform float spin;
uniform float phi0;
const float PI = 3.14159265;
void main() {
  vec2 p = vec2(v.x, v.y);
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float z = sqrt(1.0 - r2);
  float lat = asin(clamp(z * sin(phi0) + p.y * cos(phi0), -1.0, 1.0));
  float lon = atan(p.x, z * cos(phi0) - p.y * sin(phi0));
  vec2 uv = vec2(fract((lon + spin + PI) / (2.0 * PI)), (PI * 0.5 - lat) / PI);
  vec3 c = texture2D(map, uv).rgb;
  vec3 light = normalize(vec3(-0.35, 0.45, 0.82));
  c *= 0.9 + 0.18 * dot(vec3(p, z), light);
  float haze = pow(1.0 - z, 3.0);
  c = mix(c, vec3(0.55, 0.86, 0.95), 0.5 * haze);
  // Leave the outermost ring to the painting's own atmosphere.
  float alpha = 1.0 - smoothstep(0.955, 1.0, sqrt(r2));
  gl_FragColor = vec4(c * alpha, alpha);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "shader");
  return shader;
}

/**
 * @param {SVGForeignObjectElement} host  covers exactly the globe's disk in scene units
 * @param {{ paused(): boolean, reducedMotion(): boolean }} hooks
 */
export function createSpinningGlobe(host, hooks) {
  const canvas = host.querySelector("canvas");
  let gl = null;
  let program = null;
  let uniforms = null;
  let texture = null;
  let image = null;
  let state = "idle"; // idle | loading | ready | failed
  let running = false;
  let frame = 0;
  let last = 0;
  let spin = 0;
  let resizeObserver = null;
  let sized = "";
  let wanted = false;

  function setup() {
    gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("webgl");
    program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("link");
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    uniforms = { spin: gl.getUniformLocation(program, "spin"), phi0: gl.getUniformLocation(program, "phi0") };
    gl.uniform1f(uniforms.phi0, PHI0);
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // No mipmaps: the longitude wrap would pick a tiny mip along the seam.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    gl.clearColor(0, 0, 0, 0);
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      fail();
    }, { once: true });
  }

  function fail() {
    state = "failed";
    stop();
    host.dataset.state = "failed";
  }

  function resize() {
    const rect = host.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const size = Math.round(Math.max(128, Math.min(1024, rect.width * dpr)));
    const key = String(size);
    if (key === sized) return;
    sized = key;
    canvas.width = size;
    canvas.height = size;
    gl?.viewport(0, 0, size, size);
  }

  function draw() {
    gl.uniform1f(uniforms.spin, spin);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function tick(now) {
    if (!running) return;
    frame = requestAnimationFrame(tick);
    if (hooks.reducedMotion()) {
      stop();
      return;
    }
    const elapsed = last ? now - last : 0;
    if (last && elapsed < FRAME_MS) return;
    last = now;
    // Paused behind a dialog: keep the angle, do not jump when it closes.
    if (hooks.paused()) return;
    // Eastward rotation: surface features drift from left to right.
    spin -= ((2 * Math.PI) / SECONDS_PER_TURN) * (Math.min(elapsed, 100) / 1000);
    draw();
  }

  function begin() {
    resize();
    resizeObserver = new ResizeObserver(() => {
      resize();
      if (state === "ready") draw();
    });
    resizeObserver.observe(host.ownerSVGElement || host);
    draw();
    host.dataset.state = "live";
    last = 0;
    running = true;
    frame = requestAnimationFrame(tick);
  }

  function start() {
    if (running || state === "failed" || hooks.reducedMotion()) return;
    if (state === "ready") {
      begin();
      return;
    }
    if (state === "loading") return;
    state = "loading";
    image = new Image();
    image.decoding = "async";
    image.onload = () => {
      try {
        setup();
        state = "ready";
        if (wanted) begin();
      } catch {
        fail();
      }
    };
    image.onerror = fail;
    image.src = MAP_URL;
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frame);
    frame = 0;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (host.dataset.state === "live") host.dataset.state = "paused";
  }

  return {
    start() {
      wanted = true;
      start();
    },
    stop() {
      wanted = false;
      stop();
    },
    debug: () => ({ state, running, spin: Number(spin.toFixed(3)), size: sized }),
  };
}
