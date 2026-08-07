/**
 * Apple Books true page-curl physics (perpendicular bisector + cylinder).
 *
 * Fold axis = perpendicular through the midpoint of (corner → finger).
 * Only the turning sheet deforms; the destination sheet stays flat.
 */

/** Flat page — destination sheet under the curl. */
export const flatVertexShader = /* glsl */ `
precision highp float;

varying vec2 vUv;
varying float vShade;
varying float vFresnel;
varying float vBackface;

void main() {
  vUv = uv;
  vShade = 1.0;
  vFresnel = 0.0;
  vBackface = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Curling sheet — Devin / Apple Books cylinder wrap.
 *
 * uOrigin / uTip are page UV (0..1). Converted to page-local XY here so the
 * bisector math matches the classic world-space formulation.
 */
export const pageVertexShader = /* glsl */ `
precision highp float;

uniform float uWidth;
uniform float uHeight;
uniform vec2 uTip;
uniform vec2 uOrigin;
uniform float uRadius;
uniform float uActive;

varying vec2 vUv;
varying float vShade;
varying float vFresnel;
varying float vBackface;

const float PI = 3.141592653589793;

void main() {
  vUv = uv;
  vShade = 1.0;
  vFresnel = 0.0;
  vBackface = 0.0;

  vec3 p = position;

  // Page-local coordinates (origin at page centre), same space as PlaneGeometry.
  vec2 corner = vec2((uOrigin.x - 0.5) * uWidth, (uOrigin.y - 0.5) * uHeight);
  vec2 pointer = vec2((uTip.x - 0.5) * uWidth, (uTip.y - 0.5) * uHeight);

  // Vector from finger to the grabbed corner — fold normal.
  vec2 dir = corner - pointer;
  float distToCorner = length(dir);

  if (uActive < 0.001 || distToCorner < 0.001) {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    return;
  }

  dir /= distToCorner;

  // Perpendicular bisector of corner↔finger is the cylinder axis.
  vec2 midPoint = (corner + pointer) * 0.5;

  float R = max(uRadius, uWidth * 0.04);
  // Signed distance past the fold toward the peeled side.
  float d = dot(p.xy - midPoint, dir);

  if (d > 0.0) {
    float maxRoll = PI * R;
    if (d < maxRoll) {
      // On the cylinder.
      float theta = d / R;
      float sA = sin(theta);
      float cA = cos(theta);
      p.xy -= dir * (d - R * sA);
      p.z = R * (1.0 - cA);
      vShade = mix(0.55, 1.0, cA);
      vFresnel = pow(clamp(1.0 - cA, 0.0, 1.0), 1.6) * 0.22;
    } else {
      // Flat back face after a half-turn of the cylinder (demo formula).
      p.xy -= dir * (2.0 * d - maxRoll);
      p.z = 2.0 * R;
      vShade = 0.88;
      vFresnel = 0.0;
    }
    // Past the crest → show the reverse side of the sheet.
    vBackface = d > (0.5 * PI * R) ? 1.0 : 0.0;
  } else {
    // Still-flat side: soft contact darkening into the crease.
    float amount = clamp(distToCorner / max(length(vec2(uWidth, uHeight)), 0.001), 0.0, 1.0);
    float crease = exp(clamp(d, -uWidth, 0.0) * (8.0 / max(uWidth, 0.001)));
    vShade = 1.0 - crease * 0.2 * smoothstep(0.0, 0.25, amount);
  }

  p.z = clamp(p.z, -0.01, R * 2.5);

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
varying float vBackface;

void main() {
  vec4 frontColor = mix(vec4(uPaperColor, 1.0), texture2D(uFront, vUv), uHasFront);
  vec2 backUv = vec2(1.0 - vUv.x, vUv.y);
  vec4 backColor = mix(vec4(uPaperColor, 1.0), texture2D(uBack, backUv), uHasBack);
  // Reverse side is slightly dimmer — matches printed paper.
  backColor.rgb *= 0.92;

  // Prefer deformation-based facing: custom vertex warp breaks gl_FrontFacing.
  vec4 color = vBackface > 0.5 ? backColor : frontColor;

  float shade = clamp(vShade, 0.4, 1.15);
  color.rgb *= shade * uPageDim;
  color.rgb += vec3(clamp(vFresnel, 0.0, 0.35));

  // Soft contact shadow on the flat destination page only.
  if (uIsTurning < 0.5 && uActive > 0.02) {
    vec2 delta = (vUv - uTip) * vec2(1.1, 1.25);
    float pool = exp(-dot(delta, delta) * 6.0) * clamp(uActive, 0.0, 1.0) * 0.38;
    color.rgb *= 1.0 - clamp(pool, 0.0, 0.5);
  }

  gl_FragColor = vec4(color.rgb, color.a * uOpacity);
}
`;
