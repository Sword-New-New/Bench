// The dark theme's wallpaper, drawn by the GPU at the screen's own
// resolution (ambient.tsx): a deep blue-black base, a cool glow low in the
// middle and a violet one top left, three soft aurora ribbons across the
// top, a vignette, and a dither of about one colour step so the dark
// gradients don't band. Drawn in a virtual 2560×1600 frame laid over the
// screen like `background-size: cover`, so it matches the image it replaced
// (public/wallpapers/deep-aurora.webp, still the fallback without WebGL).
// `time` (seconds) drifts the ribbons; 0 is the still picture.

const VERTEX = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`

const FRAGMENT = `
precision highp float;
uniform vec2 uSize;   // canvas, device pixels
uniform float uTime;
const vec2 F = vec2(2560.0, 1600.0);
const float TAU = 6.28318530718;

vec3 rgb(float r, float g, float b) { return vec3(r, g, b) / 255.0; }

// A soft band along a wavy line, added with "screen".
vec3 ribbon(vec3 c, vec2 q, float y0, float amp, float width, vec3 col, float alpha, float soft, float phase, float freq, float tilt, float rise) {
  float t = q.x / F.x;
  float y = y0 + rise + tilt * t * F.y + sin(t * freq * TAU + phase) * amp + sin(t * freq * 5.3 + phase * 1.7) * amp * 0.25;
  float d = abs(q.y - y);
  float reach = width * 0.5 + soft;
  float k = 1.0 - smoothstep(0.0, reach, d);
  float i = alpha * 0.95 * k * k * (3.0 - 2.0 * k);
  return 1.0 - (1.0 - c) * (1.0 - col * i);
}

vec3 glow(vec3 c, vec2 q, vec2 at, float r, vec3 col, float a) {
  float k = clamp(1.0 - length(q - at) / r, 0.0, 1.0);
  return mix(c, col, a * k);
}

float hash(vec2 v) { return fract(sin(dot(v, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 px = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  float s = max(uSize.x / F.x, uSize.y / F.y);
  vec2 q = (px - (uSize - F * s) * 0.5) / s;

  vec2 dir = vec2(F.x * 0.3, F.y);
  float g = clamp(dot(q, dir) / dot(dir, dir), 0.0, 1.0);
  vec3 c = mix(rgb(5.0, 7.0, 15.0), rgb(3.0, 4.0, 10.0), g);
  c = glow(c, q, vec2(F.x * 0.55, F.y * 1.05), F.y * 0.9, rgb(18.0, 44.0, 120.0), 0.55);
  c = glow(c, q, vec2(F.x * 0.10, 0.0), F.y * 0.8, rgb(30.0, 26.0, 90.0), 0.45);

  // The waves travel along the ribbons and each ribbon rises and sinks a
  // little, out of step with the others; at time 0 it's the still picture.
  float w = uTime * 0.22;
  float r = uTime * 0.21;
  c = ribbon(c, q, F.y * 0.18, F.y * 0.09, F.y * 0.22, rgb(40.0, 140.0, 200.0), 0.16, 56.0, 0.6 + w, 0.8, 0.35, sin(r) * F.y * 0.04);
  c = ribbon(c, q, F.y * 0.30, F.y * 0.07, F.y * 0.16, rgb(90.0, 90.0, 230.0), 0.14, 70.0, 2.1 - w * 0.8, 0.65, 0.25, sin(r * 0.73) * -F.y * 0.035);
  c = ribbon(c, q, F.y * 0.10, F.y * 0.05, F.y * 0.08, rgb(120.0, 200.0, 240.0), 0.10, 36.0, 1.2 + w * 1.3, 0.9, 0.4, sin(r * 1.31) * F.y * 0.03);

  vec2 vc = vec2(F.x * 0.5, F.y * 0.55);
  float v = clamp((length(q - vc) - F.y * 0.35) / (F.y * 0.8), 0.0, 1.0);
  c *= 1.0 - 0.75 * v;

  // About one step of 8-bit colour, triangular: no banding, no visible grain.
  float n = hash(px) - hash(px + 17.31);
  gl_FragColor = vec4(c + n / 255.0, 1.0);
}
`

export type Aurora = { draw: (time?: number) => void; dispose: () => void }

// null: no WebGL here (the caller keeps the image).
export function makeAurora(canvas: HTMLCanvasElement): Aurora | null {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true, powerPreference: "low-power" })
  if (!gl || gl.isContextLost()) return null
  const shader = (type: number, source: string) => {
    const made = gl.createShader(type)!
    gl.shaderSource(made, source)
    gl.compileShader(made)
    if (!gl.getShaderParameter(made, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(made) ?? "shader")
    return made
  }
  let program: WebGLProgram
  try {
    program = gl.createProgram()!
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
  } catch {
    return null
  }
  gl.useProgram(program)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const at = gl.getAttribLocation(program, "p")
  gl.enableVertexAttribArray(at)
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0)
  const size = gl.getUniformLocation(program, "uSize")
  const time = gl.getUniformLocation(program, "uTime")

  return {
    draw(seconds = 0) {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(canvas.clientWidth * ratio))
      const h = Math.max(1, Math.round(canvas.clientHeight * ratio))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      gl.viewport(0, 0, w, h)
      gl.uniform2f(size, w, h)
      gl.uniform1f(time, seconds)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      // The context stays: the canvas keeps it, and a remount (React's dev
      // double mount) asks the same canvas again; a lost one would come back.
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
    },
  }
}
