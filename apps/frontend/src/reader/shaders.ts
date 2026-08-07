/**
 * Apple Books true page-curl physics (perpendicular bisector + cylinder).
 *
 * Exact fold model from the reference demo:
 *   dir = normalize(uCorner - uPointer)
 *   mid = (uCorner + uPointer) * 0.5
 *   d   = dot(p.xy - mid, dir)
 * Vertices with d > 0 wrap around a cylinder of radius uRadius.
 *
 * uPointer / uCorner are page-local XY (origin at page centre), same space
 * as PlaneGeometry positions — not UV.
 */

/** Flat destination sheet under the curl. */
export const flatVertexShader = /* glsl */ `
precision highp float;

varying vec2 vUv;
varying float vShadow;
varying float vBackface;

void main() {
  vUv = uv;
  vShadow = 0.0;
  vBackface = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Curling sheet — perpendicular-bisector cylinder wrap. */
export const pageVertexShader = /* glsl */ `
precision highp float;

uniform vec2 uPointer;
uniform vec2 uCorner;
uniform float uRadius;

varying vec2 vUv;
varying float vShadow;
varying float vBackface;

void main() {
  vUv = uv;
  vec3 p = position;

  // Vector from finger to the grabbed corner — fold normal.
  vec2 dir = uCorner - uPointer;
  float distToCorner = length(dir);

  if (distToCorner > 0.001) {
    dir = normalize(dir);

    // Midpoint of corner↔finger: the cylinder axis lies on this bisector.
    vec2 midPoint = (uCorner + uPointer) * 0.5;

    float d = dot(p.xy - midPoint, dir);

    if (d > 0.0) {
      if (d < 3.14159265 * uRadius) {
        float theta = d / uRadius;
        p.xy -= dir * (d - uRadius * sin(theta));
        p.z = uRadius * (1.0 - cos(theta));
      } else {
        // Flat back after a half-turn of the cylinder.
        p.xy -= dir * (d + (d - 3.14159265 * uRadius));
        p.z = 2.0 * uRadius;
      }
    }

    vShadow = clamp(p.z / (uRadius * 2.0), 0.0, 1.0);
    vBackface = (d > 1.570796 * uRadius) ? 1.0 : 0.0;
  } else {
    vShadow = 0.0;
    vBackface = 0.0;
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
uniform float uIsTurning;
uniform vec2 uTip;
uniform float uActive;

varying vec2 vUv;
varying float vShadow;
varying float vBackface;

void main() {
  vec4 frontColor = mix(vec4(uPaperColor, 1.0), texture2D(uFront, vUv), uHasFront);

  vec2 backUv = vec2(1.0 - vUv.x, vUv.y);
  vec4 backColor = mix(vec4(uPaperColor, 1.0), texture2D(uBack, backUv), uHasBack);
  backColor.rgb *= 0.9;

  // Deformation-based facing — custom vertex warp breaks gl_FrontFacing.
  vec4 finalColor = (vBackface > 0.5) ? backColor : frontColor;

  float shadowFactor = 1.0 - (vShadow * 0.4);
  float highlight = pow(vShadow, 3.0) * 0.2;
  finalColor.rgb = (finalColor.rgb * shadowFactor) + vec3(highlight);
  finalColor.rgb *= uPageDim;

  // Soft contact shadow on the flat destination page only.
  if (uIsTurning < 0.5 && uActive > 0.02) {
    vec2 delta = (vUv - uTip) * vec2(1.1, 1.25);
    float pool = exp(-dot(delta, delta) * 6.0) * clamp(uActive, 0.0, 1.0) * 0.38;
    finalColor.rgb *= 1.0 - clamp(pool, 0.0, 0.5);
  }

  gl_FragColor = vec4(finalColor.rgb, finalColor.a * uOpacity);
}
`;
