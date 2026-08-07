import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  Color,
  DoubleSide,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  type Texture,
} from 'three';
import { ZOOM_TEXTURE_THRESHOLD } from './gestureMath';
import { pageFragmentShader, pageVertexShader } from './shaders';
import { progressFromTip, restCorner, tipTravel } from './pageCurlMath';
import { stepSpring, type FlipState, type TurnDirection } from './useFlipGesture';

/**
 * Scene graph for an Apple Books–style corner curl.
 *
 * Two sheets: the base shows the destination page; the top sheet carries the
 * current page on its front and the destination on its back, and deforms so
 * its corner follows the finger (or a settling spring toward complete/cancel).
 */

export interface FlipSceneProps {
  gesture: React.RefObject<FlipState>;
  currentTexture: Texture | null;
  currentZoomTexture: Texture | null;
  nextTexture: Texture | null;
  prevTexture: Texture | null;
  aspect: number;
  paperColor: string;
  pageDim?: number;
  onTurnComplete: (direction: TurnDirection) => void;
  reducedMotion: boolean;
  /** Reading order — needed so tip springs land on the correct rest corner. */
  rtl?: boolean;
}

function createPageMaterial(paperColor: string, pageDim: number, turning: boolean): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: pageVertexShader,
    fragmentShader: pageFragmentShader,
    side: DoubleSide,
    transparent: true,
    depthWrite: turning,
    uniforms: {
      uWidth: { value: 1 },
      uHeight: { value: 1 },
      uTip: { value: new Vector2(1, 0) },
      uOrigin: { value: new Vector2(1, 0) },
      uActive: { value: 0 },
      uFront: { value: null },
      uBack: { value: null },
      uHasFront: { value: 0 },
      uHasBack: { value: 0 },
      uPaperColor: { value: new Color(paperColor) },
      uOpacity: { value: 1 },
      uPageDim: { value: pageDim },
      uIsTurning: { value: turning ? 1 : 0 },
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
  pageDim = 1,
  onTurnComplete,
  reducedMotion,
  rtl = false,
}: FlipSceneProps): React.JSX.Element {
  const { viewport, camera, invalidate } = useThree();

  const { pageWidth, pageHeight } = useMemo(() => {
    const maxH = viewport.height * 0.98;
    const maxW = viewport.width * 0.98;
    const byHeight = { w: maxH * aspect, h: maxH };
    return byHeight.w <= maxW
      ? { pageWidth: byHeight.w, pageHeight: byHeight.h }
      : { pageWidth: maxW, pageHeight: maxW / aspect };
  }, [viewport.width, viewport.height, aspect]);

  // Dense mesh so the cylinder crease reads as smooth paper, not facets.
  const geometry = useMemo(
    () => new PlaneGeometry(pageWidth, pageHeight, 64, 64),
    [pageWidth, pageHeight],
  );
  const sheetMaterial = useMemo(() => createPageMaterial(paperColor, pageDim, true), []);
  const baseMaterial = useMemo(() => createPageMaterial(paperColor, pageDim, false), []);

  const tipVx = useRef(0);
  const tipVy = useRef(0);
  const progressVelocity = useRef(0);

  useEffect(() => {
    sheetMaterial.uniforms['uWidth']!.value = pageWidth;
    sheetMaterial.uniforms['uHeight']!.value = pageHeight;
    baseMaterial.uniforms['uWidth']!.value = pageWidth;
    baseMaterial.uniforms['uHeight']!.value = pageHeight;
    invalidate();
  }, [pageWidth, pageHeight, sheetMaterial, baseMaterial, invalidate]);

  useEffect(() => {
    (sheetMaterial.uniforms['uPaperColor']!.value as Color).set(paperColor);
    (baseMaterial.uniforms['uPaperColor']!.value as Color).set(paperColor);
    sheetMaterial.uniforms['uPageDim']!.value = pageDim;
    baseMaterial.uniforms['uPageDim']!.value = pageDim;
    invalidate();
  }, [paperColor, pageDim, sheetMaterial, baseMaterial, invalidate]);

  useEffect(() => {
    invalidate();
  }, [currentTexture, currentZoomTexture, nextTexture, prevTexture, invalidate]);

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

    if (!state.dragging) {
      if (state.springImpulse !== 0) {
        // Convert progress impulse into tip velocity along X.
        tipVx.current = state.springImpulse * 0.85;
        tipVy.current = Math.abs(state.springImpulse) * 0.12;
        progressVelocity.current = state.springImpulse;
        state.springImpulse = 0;
      }

      const sx = stepSpring(state.tipX, state.targetTipX, tipVx.current, delta);
      const sy = stepSpring(state.tipY, state.targetTipY, tipVy.current, delta);
      state.tipX = sx.value;
      state.tipY = sy.value;
      tipVx.current = sx.velocity;
      tipVy.current = sy.velocity;

      if (state.direction) {
        state.progress = progressFromTip(state.tipX, state.tipY, state.direction, rtl);
      } else {
        state.progress = 0;
      }
    } else {
      tipVx.current = 0;
      tipVy.current = 0;
      progressVelocity.current = 0;
    }

    const direction = state.direction;
    const forward = !direction || direction === 'next';
    const destination = forward ? nextTexture : prevTexture;
    const front =
      state.scale >= ZOOM_TEXTURE_THRESHOLD && currentZoomTexture
        ? currentZoomTexture
        : currentTexture;

    const travel = direction
      ? tipTravel(state.tipX, state.tipY, direction, rtl)
      : 0;
    const active = Math.min(1, travel * 2.2);

    const tipUniform = sheetMaterial.uniforms['uTip']!.value as Vector2;
    const originUniform = sheetMaterial.uniforms['uOrigin']!.value as Vector2;
    tipUniform.set(state.tipX, state.tipY);
    originUniform.set(state.originX, state.originY);

    const baseTip = baseMaterial.uniforms['uTip']!.value as Vector2;
    const baseOrigin = baseMaterial.uniforms['uOrigin']!.value as Vector2;
    baseTip.set(state.tipX, state.tipY);
    baseOrigin.set(state.originX, state.originY);

    if (reducedMotion) {
      const mag = Math.min(1, Math.abs(state.progress));
      sheetMaterial.uniforms['uActive']!.value = 0;
      sheetMaterial.uniforms['uOpacity']!.value = 1 - mag;
      baseMaterial.uniforms['uActive']!.value = 0;
    } else {
      sheetMaterial.uniforms['uActive']!.value = active;
      sheetMaterial.uniforms['uOpacity']!.value = 1;
      baseMaterial.uniforms['uActive']!.value = active;
    }

    sheetMaterial.uniforms['uFront']!.value = front;
    sheetMaterial.uniforms['uHasFront']!.value = front ? 1 : 0;
    sheetMaterial.uniforms['uBack']!.value = destination;
    sheetMaterial.uniforms['uHasBack']!.value = destination ? 1 : 0;

    baseMaterial.uniforms['uFront']!.value = destination;
    baseMaterial.uniforms['uHasFront']!.value = destination ? 1 : 0;
    baseMaterial.uniforms['uBack']!.value = null;
    baseMaterial.uniforms['uHasBack']!.value = 0;

    camera.position.x = -state.panX / 200;
    camera.position.y = state.panY / 200;
    camera.zoom = state.scale;
    camera.updateProjectionMatrix();

    // Turn is done when the tip has reached (or passed) its complete target.
    const tipSettled =
      Math.abs(state.tipX - state.targetTipX) < 0.02 &&
      Math.abs(state.tipY - state.targetTipY) < 0.02 &&
      Math.abs(tipVx.current) < 0.05;
    const completing =
      state.settling &&
      direction &&
      Math.abs(state.target) > 0.5 &&
      tipSettled;

    if (completing && !state.dragging) {
      const turnDir: TurnDirection = direction;
      state.settling = false;
      state.progress = 0;
      state.target = 0;
      state.direction = null;
      const rest = restCorner('next', rtl); // idle pose; unused until next drag
      state.tipX = rest.x;
      state.tipY = rest.y;
      state.targetTipX = rest.x;
      state.targetTipY = rest.y;
      state.originX = rest.x;
      state.originY = rest.y;
      tipVx.current = 0;
      tipVy.current = 0;
      progressVelocity.current = 0;

      sheetMaterial.uniforms['uActive']!.value = 0;
      sheetMaterial.uniforms['uOpacity']!.value = 1;
      sheetMaterial.uniforms['uFront']!.value = destination;
      sheetMaterial.uniforms['uHasFront']!.value = destination ? 1 : 0;
      sheetMaterial.uniforms['uBack']!.value = null;
      sheetMaterial.uniforms['uHasBack']!.value = 0;
      baseMaterial.uniforms['uActive']!.value = 0;
      baseMaterial.uniforms['uFront']!.value = destination;
      baseMaterial.uniforms['uHasFront']!.value = destination ? 1 : 0;

      onTurnComplete(turnDir);
    }

    // Cancelled peel finished returning home.
    if (
      !state.dragging &&
      !state.settling &&
      direction &&
      Math.abs(state.target) < 0.001 &&
      tipSettled &&
      travel < 0.02
    ) {
      state.direction = null;
      state.progress = 0;
      sheetMaterial.uniforms['uActive']!.value = 0;
      baseMaterial.uniforms['uActive']!.value = 0;
    }

    const busy =
      state.dragging ||
      state.settling ||
      travel > 0.008 ||
      Math.abs(tipVx.current) > 0.01 ||
      Math.abs(tipVy.current) > 0.01 ||
      Math.abs(state.scale - 1) > 0.001 ||
      Math.abs(state.panX) > 0.5 ||
      Math.abs(state.panY) > 0.5;
    if (busy) invalidate();
  });

  return (
    <>
      <mesh geometry={geometry} material={baseMaterial} renderOrder={0} />
      <mesh geometry={geometry} material={sheetMaterial} renderOrder={1} position={[0, 0, 0.001]} />
    </>
  );
}
