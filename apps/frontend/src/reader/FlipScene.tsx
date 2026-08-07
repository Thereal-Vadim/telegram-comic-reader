import { useEffect, useMemo } from 'react';
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
import {
  paperLerpAlpha,
  progressFromTip,
  restCorner,
  tipTravel,
  type PageLayout,
} from './pageCurlMath';
import { flatVertexShader, pageFragmentShader, pageVertexShader } from './shaders';
import type { FlipState, TurnDirection } from './useFlipGesture';

/**
 * Apple Books true physics curl.
 *
 * Base sheet stays flat (destination + contact shadow).
 * Top sheet alone deforms; tip eases toward the finger with paper lerp.
 */

export interface FlipSceneProps {
  gesture: React.RefObject<FlipState>;
  /** Written each frame so gestures can raycast onto the letterboxed page. */
  layoutRef: React.MutableRefObject<PageLayout>;
  currentTexture: Texture | null;
  currentZoomTexture: Texture | null;
  nextTexture: Texture | null;
  prevTexture: Texture | null;
  aspect: number;
  paperColor: string;
  pageDim?: number;
  onTurnComplete: (direction: TurnDirection) => void;
  reducedMotion: boolean;
  rtl?: boolean;
}

/** Dense mesh — diagonal folds stay smooth (demo uses 128×128). */
const PAGE_SEGMENTS = 128;

function createMaterial(
  paperColor: string,
  pageDim: number,
  turning: boolean,
): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: turning ? pageVertexShader : flatVertexShader,
    fragmentShader: pageFragmentShader,
    side: DoubleSide,
    transparent: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: turning ? -1 : 1,
    polygonOffsetUnits: turning ? -1 : 1,
    uniforms: {
      uWidth: { value: 1 },
      uHeight: { value: 1 },
      uTip: { value: new Vector2(1, 0) },
      uOrigin: { value: new Vector2(1, 0) },
      uRadius: { value: 0.18 },
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
  layoutRef,
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

  const geometry = useMemo(
    () => new PlaneGeometry(pageWidth, pageHeight, PAGE_SEGMENTS, PAGE_SEGMENTS),
    [pageWidth, pageHeight],
  );
  const sheetMaterial = useMemo(() => createMaterial(paperColor, pageDim, true), []);
  const baseMaterial = useMemo(() => createMaterial(paperColor, pageDim, false), []);

  useEffect(() => {
    layoutRef.current = {
      pageWidth,
      pageHeight,
      viewWidth: viewport.width,
      viewHeight: viewport.height,
    };
  }, [layoutRef, pageWidth, pageHeight, viewport.width, viewport.height]);

  useEffect(() => {
    const radius = pageWidth * 0.11;
    for (const mat of [sheetMaterial, baseMaterial]) {
      mat.uniforms['uWidth']!.value = pageWidth;
      mat.uniforms['uHeight']!.value = pageHeight;
      mat.uniforms['uRadius']!.value = radius;
    }
    invalidate();
  }, [pageWidth, pageHeight, sheetMaterial, baseMaterial, invalidate]);

  useEffect(() => {
    for (const mat of [sheetMaterial, baseMaterial]) {
      (mat.uniforms['uPaperColor']!.value as Color).set(paperColor);
      mat.uniforms['uPageDim']!.value = pageDim;
    }
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

    layoutRef.current = {
      pageWidth,
      pageHeight,
      viewWidth: viewport.width,
      viewHeight: viewport.height,
    };

    // Paper weight: tip always eases toward the finger / settle target.
    if (reducedMotion) {
      state.tipX = state.targetTipX;
      state.tipY = state.targetTipY;
    } else {
      const alpha = paperLerpAlpha(delta);
      state.tipX += (state.targetTipX - state.tipX) * alpha;
      state.tipY += (state.targetTipY - state.tipY) * alpha;
    }

    const cornerY = state.cornerY;
    if (state.direction) {
      state.progress = progressFromTip(
        state.tipX,
        state.tipY,
        state.direction,
        rtl,
        cornerY,
      );
    } else {
      state.progress = 0;
    }

    const direction = state.direction;
    const forward = !direction || direction === 'next';
    const destination = forward ? nextTexture : prevTexture;
    const front =
      state.scale >= ZOOM_TEXTURE_THRESHOLD && currentZoomTexture
        ? currentZoomTexture
        : currentTexture;

    const travel = direction
      ? tipTravel(state.tipX, state.tipY, direction, rtl, cornerY)
      : 0;
    const active = direction ? Math.min(1, Math.max(0, (travel - 0.02) / 0.5)) : 0;

    const tip = sheetMaterial.uniforms['uTip']!.value as Vector2;
    const origin = sheetMaterial.uniforms['uOrigin']!.value as Vector2;
    tip.set(state.tipX, state.tipY);
    origin.set(state.originX, state.originY);

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

    baseMaterial.uniforms['uFront']!.value = destination ?? front;
    baseMaterial.uniforms['uHasFront']!.value = destination || front ? 1 : 0;
    baseMaterial.uniforms['uBack']!.value = null;
    baseMaterial.uniforms['uHasBack']!.value = 0;

    camera.position.x = -state.panX / 200;
    camera.position.y = state.panY / 200;
    camera.zoom = state.scale;
    camera.updateProjectionMatrix();

    const tipSettled =
      Math.abs(state.tipX - state.targetTipX) < 0.025 &&
      Math.abs(state.tipY - state.targetTipY) < 0.025;

    const completing =
      state.settling &&
      !!direction &&
      Math.abs(state.target) > 0.5 &&
      tipSettled;

    if (completing && !state.dragging) {
      const turnDir = direction;
      state.settling = false;
      state.progress = 0;
      state.target = 0;
      state.direction = null;
      state.cornerY = 0;
      const rest = restCorner('next', rtl, 0);
      state.tipX = rest.x;
      state.tipY = rest.y;
      state.targetTipX = rest.x;
      state.targetTipY = rest.y;
      state.originX = rest.x;
      state.originY = rest.y;

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
      state.cornerY = 0;
      sheetMaterial.uniforms['uActive']!.value = 0;
      baseMaterial.uniforms['uActive']!.value = 0;
    }

    const busy =
      state.dragging ||
      state.settling ||
      travel > 0.008 ||
      Math.abs(state.tipX - state.targetTipX) > 0.002 ||
      Math.abs(state.tipY - state.targetTipY) > 0.002 ||
      Math.abs(state.scale - 1) > 0.001 ||
      Math.abs(state.panX) > 0.5 ||
      Math.abs(state.panY) > 0.5;
    if (busy) invalidate();
  });

  return (
    <>
      <mesh geometry={geometry} material={baseMaterial} renderOrder={0} />
      <mesh
        geometry={geometry}
        material={sheetMaterial}
        renderOrder={1}
        position={[0, 0, 0.002]}
      />
    </>
  );
}
