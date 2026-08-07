/**
 * Apple Books–style page curl.
 *
 * Classic perpendicular-bisector + cylinder wrap:
 * the dragged corner (tip) is the current position of the page corner; the fold
 * is the perpendicular bisector between the rest corner and the tip; vertices
 * past the fold wrap around a cylinder whose radius shrinks as the turn
 * progresses. That is the same geometric model iBooks / Apple Books use for
 * the interactive corner peel — the page stretches from the corner toward
 * wherever the finger is.
 */

export const pageVertexShader = /* glsl */ `
precision highp float;

uniform float uWidth;
uniform float uHeight;
/** Tip of the curling corner in page UV (0..1). Follows the finger while dragging. */
uniform vec2 uTip;
/** Rest position of that corner in page UV (e.g. bottom-right = 1,0). */
uniform vec2 uOrigin;
uniform float uActive; // 0 = flat page, 1 = curl engaged

varying vec2 vUv;
varying float vShade;
varying float vFresnel;

const float PI = 3.141592653589793;

void main() {
  vUv = uv;
  vShade = 1.0;
  vFresnel = 0.0;

  vec3 p = position;
  float halfW = uWidth * 0.5;
  float halfH = uHeight * 0.5;

  // Page local: origin at centre, x right, y up (matches Three plane).
  vec2 origin = vec2((uOrigin.x - 0.5) * uWidth, (uOrigin.y - 0.5) * uHeight);
  vec2 tip = vec2((uTip.x - 0.5) * uWidth, (uTip.y - 0.5) * uHeight);

  vec2 toTip = tip - origin;
  float travel = length(toTip);

  if (uActive < 0.001 || travel < 0.0005) {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    return;
  }

  vec2 n = toTip / travel;
  vec2 mid = (origin + tip) * 0.5;

  // Tighter curl as the tip travels further — paper rolls smaller near the end.
  float t = clamp(travel / (uWidth * 1.15), 0.0, 1.0);
  float R = mix(uWidth * 0.16, uWidth * 0.045, t);
  R = max(R, uWidth * 0.03);

  vec2 q = p.xy;
  float d = dot(q - mid, n);

  if (d > 0.0) {
    float angle = d / R;

    if (angle < PI) {
      // On the cylinder: roll off the page toward the reader.
      float sA = sin(angle);
      float cA = cos(angle);
      p.xy = q - n * d + n * (R * sA);
      p.z = R * (1.0 - cA);
      // Directional shade + bright rim on the curl crest.
      vShade = clamp(0.52 + 0.48 * cA, 0.45, 1.0);
      vFresnel = pow(1.0 - cA, 2.0) * 0.35;
    } else {
      // Past π: page has flipped; lie nearly flat on the back side.
      float over = (angle - PI) * R;
      p.xy = mid - n * (R * PI - over);
      // Slight lift so the back face clears the destination sheet.
      p.z = 0.002 + min(over * 0.02, 0.02);
      vShade = 0.88;
      vFresnel = 0.0;
    }
  } else {
    // Still-flat side of the fold — soft contact shadow near the crease.
    float crease = exp(d * (10.0 / max(uWidth, 0.001)));
    vShade = 1.0 - crease * 0.28 * smoothstep(0.0, 0.12, t);
  }

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
uniform float uIsTurning; // 1 for the curling sheet, 0 for the static base
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
    // Underside of the peeling sheet — mirrored so type stays readable.
    vec2 backUv = vec2(1.0 - vUv.x, vUv.y);
    color = mix(vec4(uPaperColor, 1.0), texture2D(uBack, backUv), uHasBack);
  }

  color.rgb *= vShade * uPageDim;
  // Specular kiss along the curl crest (paper highlight).
  color.rgb += vec3(vFresnel) * 0.55;

  // Soft pooled shadow on the destination page under the moving tip.
  if (uIsTurning < 0.5 && uActive > 0.01) {
    vec2 delta = (vUv - uTip) * vec2(1.15, 1.35);
    float pool = exp(-dot(delta, delta) * 7.5) * uActive * 0.42;
    color.rgb *= 1.0 - pool;
  }

  gl_FragColor = vec4(color.rgb, color.a * uOpacity);
}
`;
