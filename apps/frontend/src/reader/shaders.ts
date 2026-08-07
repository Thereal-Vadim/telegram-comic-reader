/**
 * Apple Books–style page curl.
 *
 * The turning sheet uses a perpendicular-bisector + cylinder wrap so the
 * corner follows the finger. The destination sheet stays completely flat
 * (separate vertex shader) — deforming both was the black-screen / triangle
 * artifact the previous build showed.
 */

/** Flat page — used for the destination sheet under the curl. */
export const flatVertexShader = /* glsl */ `
precision highp float;

varying vec2 vUv;
varying float vShade;
varying float vFresnel;

void main() {
  vUv = uv;
  vShade = 1.0;
  vFresnel = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Curling sheet. Origin = rest corner (e.g. bottom-right), tip = finger.
 * Vertices on the tip side of the fold wrap around a cylinder; the rest stay flat.
 */
export const pageVertexShader = /* glsl */ `
precision highp float;

uniform float uWidth;
uniform float uHeight;
uniform vec2 uTip;
uniform vec2 uOrigin;
uniform float uActive;

varying vec2 vUv;
varying float vShade;
varying float vFresnel;

const float PI = 3.141592653589793;

void main() {
  vUv = uv;
  vShade = 1.0;
  vFresnel = 0.0;

  vec3 p = position;

  vec2 origin = vec2((uOrigin.x - 0.5) * uWidth, (uOrigin.y - 0.5) * uHeight);
  vec2 tip = vec2((uTip.x - 0.5) * uWidth, (uTip.y - 0.5) * uHeight);
  vec2 toTip = tip - origin;
  float travel = length(toTip);

  // Not peeling yet — stay a flat billboard.
  if (uActive < 0.001 || travel < uWidth * 0.02) {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    return;
  }

  vec2 n = toTip / travel;
  vec2 mid = (origin + tip) * 0.5;

  // Cylinder radius: larger at the start of the peel (softer), tighter later.
  float amount = clamp(travel / (length(vec2(uWidth, uHeight)) * 0.95), 0.0, 1.0);
  float R = mix(uWidth * 0.22, uWidth * 0.06, amount);
  R = clamp(R, uWidth * 0.04, uWidth * 0.28);

  vec2 q = p.xy;
  // Signed distance past the fold toward the tip.
  float d = dot(q - mid, n);

  if (d > 0.0) {
    // Clamp so a huge d never produces NaNs / wild verts (green sparkles).
    float angle = clamp(d / R, 0.0, PI);

    if (angle < PI - 0.001) {
      float sA = sin(angle);
      float cA = cos(angle);
      // Standard page-curl cylinder: slide back to the fold, then roll up.
      p.xy = q - n * d + n * (R * sA);
      p.z = R * (1.0 - cA);
      vShade = mix(0.55, 1.0, cA);
      vFresnel = pow(clamp(1.0 - cA, 0.0, 1.0), 1.6) * 0.28;
    } else {
      // Fully rolled: mirror onto the back, almost flat.
      float over = d - R * PI;
      over = min(over, uWidth);
      p.xy = mid - n * (R * PI) - n * over;
      p.z = 0.004;
      vShade = 0.9;
      vFresnel = 0.0;
    }
  } else {
    // Flat side — gentle darkening into the crease.
    float crease = exp(clamp(d, -uWidth, 0.0) * (8.0 / max(uWidth, 0.001)));
    vShade = 1.0 - crease * 0.22 * smoothstep(0.0, 0.2, amount);
  }

  // Keep Z in a sane orthographic band.
  p.z = clamp(p.z, -0.01, uWidth * 0.5);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const pageFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D uFront;
uniform sampler2D uBack;
uniform float uHasFront;
uniform float uHasBack;
uniform vec3 uPaperColor;
uniform float uOpacity;
uniform float uPageDim;
uniform float uIsTurning;
uniform vec2 uTip;
uniform float uActive;

varying vec2 vUv;
varying float vShade;
varying float vFresnel;

void main() {
  vec4 color;

  if (gl_FrontFacing) {
    color = mix(vec4(uPaperColor, 1.0), texture2D(uFront, vUv), uHasFront);
  } else {
    vec2 backUv = vec2(1.0 - vUv.x, vUv.y);
    color = mix(vec4(uPaperColor, 1.0), texture2D(uBack, backUv), uHasBack);
  }

  float shade = clamp(vShade, 0.4, 1.15);
  color.rgb *= shade * uPageDim;
  color.rgb += vec3(clamp(vFresnel, 0.0, 0.4));

  // Soft contact shadow on the flat destination page only.
  if (uIsTurning < 0.5 && uActive > 0.02) {
    vec2 delta = (vUv - uTip) * vec2(1.1, 1.25);
    float pool = exp(-dot(delta, delta) * 6.0) * clamp(uActive, 0.0, 1.0) * 0.38;
    color.rgb *= 1.0 - clamp(pool, 0.0, 0.5);
  }

  gl_FragColor = vec4(color.rgb, color.a * uOpacity);
}
`;
