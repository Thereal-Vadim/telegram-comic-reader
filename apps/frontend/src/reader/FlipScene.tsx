import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, DoubleSide, PlaneGeometry, ShaderMaterial, type Texture } from 'three';
import { ZOOM_TEXTURE_THRESHOLD } from './gestureMath';
import { pageFragmentShader, pageVertexShader } from './shaders';
import { stepSpring, type FlipState, type TurnDirection } from './useFlipGesture';

/**
 * The scene graph for a single-page turn.
 *
 * Two sheets are enough. The lower one shows the destination page and never
 * moves; the upper one carries the current page on its front and the
 * destination on its back, and rotates away to reveal what is underneath.
 * A third sheet would be needed for a book-style two-page spread, which the
 * landscape mode below handles by simply widening the page and splitting the
 * texture in the shader.
 *
 * The render loop here is the only thing that runs during a turn. It reads the
 * gesture ref, advances the spring, writes one uniform, and returns. There is
 * no React state in the path, so a 60 Hz turn produces zero reconciliation.
 */

export interface FlipSceneProps {
  /** Live gesture state, mutated by the pointer handlers. */
  gesture: React.RefObject<FlipState>;
  currentTexture: Texture | null;
  /** Optional hi-res texture for the page under a pinch / double-tap zoom. */
  currentZoomTexture: Texture | null;
  nextTexture: Texture | null;
  prevTexture: Texture | null;
  /** Page aspect ratio (width / height), used to letterbox correctly. */
  aspect: number;
  paperColor: string;
  /** Called once a turn has fully settled and the index should advance. */
  onTurnComplete: (direction: TurnDirection) => void;
  /** Cross-fade instead of rotating, for prefers-reduced-motion. */
  reducedMotion: boolean;
}

function createPageMaterial(paperColor: string): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: pageVertexShader,
    fragmentShader: pageFragmentShader,
    side: DoubleSide,
    transparent: true,
    uniforms: {
      uProgress: { value: 0 },
      uWidth: { value: 1 },
      uBowAmount: { value: 0.18 },
      uFront: { value: null },
      uBack: { value: null },
      uHasFront: { value: 0 },
      uHasBack: { value: 0 },
      uPaperColor: { value: new Color(paperColor) },
      uOpacity: { value: 1 },
    },
  });
}

export function FlipScene({
  gesture,
  currentTexture,
  currentZoomTexture,
  nextTexture,
  prevTexture,
  aspect,
  paperColor,
  onTurnComplete,
  reducedMotion,
}: FlipSceneProps): React.JSX.Element {
  const { viewport, camera } = useThree();

  // Fit the page inside the viewport without distorting it. The page is sized
  // in world units so that a 1:1 pixel mapping holds at the camera distance,
  // which keeps the texture crisp instead of resampled.
  const { pageWidth, pageHeight } = useMemo(() => {
    const maxH = viewport.height * 0.98;
    const maxW = viewport.width * 0.98;
    const byHeight = { w: maxH * aspect, h: maxH };
    return byHeight.w <= maxW
      ? { pageWidth: byHeight.w, pageHeight: byHeight.h }
      : { pageWidth: maxW, pageHeight: maxW / aspect };
  }, [viewport.width, viewport.height, aspect]);

  const geometry = useMemo(
    () => new PlaneGeometry(pageWidth, pageHeight, 48, 1),
    [pageWidth, pageHeight],
  );
  const sheetMaterial = useMemo(() => createPageMaterial(paperColor), []);
  const baseMaterial = useMemo(() => createPageMaterial(paperColor), []);

  // Spring velocity persists across frames but is never read by React.
  const velocity = useRef(0);

  useEffect(() => {
    sheetMaterial.uniforms['uWidth']!.value = pageWidth;
    baseMaterial.uniforms['uWidth']!.value = pageWidth;
  }, [pageWidth, sheetMaterial, baseMaterial]);

  useEffect(() => {
    (sheetMaterial.uniforms['uPaperColor']!.value as Color).set(paperColor);
    (baseMaterial.uniforms['uPaperColor']!.value as Color).set(paperColor);
  }, [paperColor, sheetMaterial, baseMaterial]);

  // Free the per-scene GPU objects. Textures belong to the TextureManager and
  // are deliberately left alone.
  useEffect(
    () => () => {
      geometry.dispose();
      sheetMaterial.dispose();
      baseMaterial.dispose();
    },
    [geometry, sheetMaterial, baseMaterial],
  );

  useFrame((_, delta) => {
    const state = gesture.current;
    if (!state) return;

    // While dragging, progress is the finger position; the spring only takes
    // over on release. Integrating during the drag would add lag to the touch.
    if (!state.dragging) {
      const stepped = stepSpring(state.progress, state.target, velocity.current, delta);
      state.progress = stepped.value;
      velocity.current = stepped.velocity;
    } else {
      velocity.current = 0;
    }

    const p = state.progress;
    const forward = p >= 0;
    const magnitude = Math.min(1, Math.abs(p));

    // Pick which pages the two sheets show, based on turn direction. Done here
    // rather than in React so reversing mid-drag is instant.
    const destination = forward ? nextTexture : prevTexture;

    // Prefer the hi-res zoom texture once the camera is past the threshold so
    // a double-tap / pinch does not just magnify the screen-resolution page.
    const front =
      state.scale >= ZOOM_TEXTURE_THRESHOLD && currentZoomTexture
        ? currentZoomTexture
        : currentTexture;

    if (reducedMotion) {
      // Cross-fade: the sheet stays flat and its opacity falls away.
      sheetMaterial.uniforms['uProgress']!.value = 0;
      sheetMaterial.uniforms['uOpacity']!.value = 1 - magnitude;
    } else {
      sheetMaterial.uniforms['uProgress']!.value = magnitude;
      sheetMaterial.uniforms['uOpacity']!.value = 1;
    }

    sheetMaterial.uniforms['uFront']!.value = front;
    sheetMaterial.uniforms['uHasFront']!.value = front ? 1 : 0;
    sheetMaterial.uniforms['uBack']!.value = destination;
    sheetMaterial.uniforms['uHasBack']!.value = destination ? 1 : 0;

    baseMaterial.uniforms['uFront']!.value = destination;
    baseMaterial.uniforms['uHasFront']!.value = destination ? 1 : 0;

    // Pinch zoom and pan are applied to the camera rather than the meshes, so
    // the deformation maths never has to know about them.
    camera.position.x = -state.panX / 200;
    camera.position.y = state.panY / 200;
    camera.zoom = state.scale;
    camera.updateProjectionMatrix();

    // A settled turn hands control back to React exactly once.
    if (state.settling && !state.dragging && magnitude >= 0.999) {
      const direction: TurnDirection = forward ? 'next' : 'prev';
      state.settling = false;
      state.progress = 0;
      state.target = 0;
      velocity.current = 0;
      sheetMaterial.uniforms['uProgress']!.value = 0;
      sheetMaterial.uniforms['uOpacity']!.value = 1;
      onTurnComplete(direction);
    }
  });

  return (
    <>
      {/* Destination page, static beneath the turning sheet. */}
      <mesh geometry={geometry} material={baseMaterial} renderOrder={0} />
      {/* The sheet that actually turns. */}
      <mesh geometry={geometry} material={sheetMaterial} renderOrder={1} position={[0, 0, 0.001]} />
    </>
  );
}
