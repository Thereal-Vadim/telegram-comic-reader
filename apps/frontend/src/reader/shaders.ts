/**
 * GLSL for the page-turn.
 *
 * Deformation model. The plan sketched a pure moving-fold cylinder, where a
 * fold line sweeps across the page and everything past it wraps around a
 * shrinking cylinder. That produces a convincing peel in the middle of the
 * turn but the wrong end state: at full progress the page is a half-cylinder
 * standing off the surface rather than lying flat on the opposite side. What
 * is implemented here instead is a rotation about the spine combined with a
 * cylindrical bow whose amplitude peaks mid-turn:
 *
 *   phi  = PI * progress                 rotation about the spine
 *   bow  = sin(PI * progress)            0 at both ends, 1 in the middle
 *
 * At progress 0 the page is flat and unrotated; at 1 it is flat again and
 * mirrored onto the other side; in between it bows out exactly as paper does.
 * Same one-uniform drive, same segmented plane, correct resting states.
 *
 * Everything is driven by `uProgress` alone, so a turn is a single uniform
 * write per frame with no attribute uploads and no geometry rebuild.
 */

export const pageVertexShader = /* glsl */ `
precision highp float;

uniform float uProgress;   // 0 = flat and closed, 1 = fully turned
uniform float uWidth;      // page width in world units
uniform float uBowAmount;  // peak bow height as a fraction of page width
uniform float uTurnSign;   // +1 next (spine left), -1 prev (spine right)

varying vec2 vUv;
varying float vShade;

const float PI = 3.141592653589793;

void main() {
  vUv = uv;

  vec3 p = position;
  float halfW = uWidth * 0.5;

  // Distance from the active spine. Next peels from the right (hinge left);
  // prev peels from the left (hinge right) so back-turns do not curl the wrong way.
  float localX = uTurnSign > 0.0 ? (p.x + halfW) : (halfW - p.x);
  float u = clamp(localX / uWidth, 0.0, 1.0);

  float phi = PI * uProgress;
  float bow = sin(PI * uProgress) * uBowAmount * uWidth;

  // The bow is zero at the hinge and grows toward the free edge. A quarter
  // sine gives a profile close to how paper actually bends: steepest near the
  // spine, flattening out toward the edge the finger is dragging.
  float lift = sin(u * PI * 0.5) * bow;

  // Rotate (localX, lift) about the spine axis, which is vertical, so y is
  // untouched and this stays a 2D rotation in the xz plane.
  float c = cos(phi);
  float s = sin(phi);
  float rx = localX * c - lift * s;
  float rz = localX * s + lift * c;

  p.x = uTurnSign > 0.0 ? (rx - halfW) : (halfW - rx);
  p.z = rz;

  // Cheap directional shading. The surface slope in x is the derivative of the
  // lift profile; steeper slope means the surface is turned further from the
  // viewer, so it darkens. This is what makes the curl read as three
  // dimensional without a light or a normal attribute.
  float slope = cos(u * PI * 0.5) * bow * (PI * 0.5) / uWidth;
  vShade = clamp(1.0 - abs(slope) * 0.45, 0.6, 1.0);

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
uniform float uPageDim; // <1 softens bright scans for night / eye comfort

varying vec2 vUv;
varying float vShade;

void main() {
  vec4 color;

  if (gl_FrontFacing) {
    // Blend against the paper colour so a page whose texture has not landed
    // yet shows blank paper rather than transparent black.
    color = mix(vec4(uPaperColor, 1.0), texture2D(uFront, vUv), uHasFront);
  } else {
    // The reverse of a sheet is its mirror image, so flip u. Without this the
    // back of a turning page shows its content reversed left-to-right.
    vec2 backUv = vec2(1.0 - vUv.x, vUv.y);
    color = mix(vec4(uPaperColor, 1.0), texture2D(uBack, backUv), uHasBack);
  }

  gl_FragColor = vec4(color.rgb * vShade * uPageDim, color.a * uOpacity);
}
`;

/** Uniform names, centralised so a typo fails at import rather than silently. */
