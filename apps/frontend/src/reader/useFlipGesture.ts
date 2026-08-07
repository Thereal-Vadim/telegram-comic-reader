import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  clampPan,
  clampScale,
  COMMIT_THRESHOLD,
  DOUBLE_TAP_ZOOM,
  FLICK_VELOCITY,
  isDoubleTap,
  PAN_LOCKOUT_PX,
  TAP_MAX_MS,
  TAP_SLOP_PX,
  tapZone,
  type TapSample,
} from './gestureMath';
import {
  completeTip,
  cornerYFromPointer,
  progressFromTip,
  projectPointerToPage,
  restCorner,
  tipTravel,
  type PageLayout,
} from './pageCurlMath';

/**
 * Pointer handling for the reader surface.
 *
 * Finger position is projected onto the letterboxed page plane (ortho
 * raycaster). The fold corner is locked at grab time (top/bottom × edge);
 * the tip target follows the finger so the bisector fold stays under it.
 * Visual tip easing lives in FlipScene (paper lerp).
 */

export type TurnDirection = 'next' | 'prev';

/** Live animation state, mutated in place and read by `useFrame`. */
export interface FlipState {
  /** -1..1 derived from tip. Negative = prev, positive = next. */
  progress: number;
  /** Spring / settle target for progress (±1 committed, 0 cancel). */
  target: number;
  /** Rendered tip (eased) in page UV. */
  tipX: number;
  tipY: number;
  /** Finger / settle target tip in page UV. */
  targetTipX: number;
  targetTipY: number;
  /** Grabbed rest corner for the active turn. */
  originX: number;
  originY: number;
  /** Locked top (1) or bottom (0) corner for this peel. */
  cornerY: 0 | 1;
  /**
   * Latest pointer in clip space for FlipScene's Raycaster.
   * Null when the finger is up / settle owns the tip.
   */
  ndcX: number | null;
  ndcY: number | null;
  /** True while a finger is down and driving the tip target. */
  dragging: boolean;
  /** Set once a release has been committed, to suppress duplicate commits. */
  settling: boolean;
  direction: TurnDirection | null;
  /**
   * Legacy one-shot impulse retained for API compatibility; paper lerp
   * in FlipScene owns settle feel now.
   */
  springImpulse: number;
  scale: number;
  panX: number;
  panY: number;
}

export interface FlipGestureOptions {
  onCommit: (direction: TurnDirection) => void;
  onTapCentre: () => void;
  onThresholdCrossed?: () => void;
  onScaleChange?: (scale: number) => void;
  canTurn: (direction: TurnDirection) => boolean;
  /** Shared with FlipScene — page letterbox in world units. */
  layoutRef: React.RefObject<PageLayout>;
  rtl?: boolean;
  reducedMotion?: boolean;
}

export interface FlipGestureHandles {
  readonly state: React.RefObject<FlipState>;
  readonly bind: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
  startTurn: (direction: TurnDirection) => void;
  resetZoom: () => void;
  /** Adjust camera scale from the settings sheet (positive = zoom in). */
  nudgeScale: (delta: number) => void;
  getScale: () => number;
}

interface PointerRecord {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
  lastX: number;
  lastY: number;
  lastTime: number;
  velocityX: number;
  velocityY: number;
}

interface PinchStart {
  distance: number;
  scale: number;
  midX: number;
  midY: number;
  panX: number;
  panY: number;
}

function idleTip(): Pick<
  FlipState,
  | 'tipX'
  | 'tipY'
  | 'targetTipX'
  | 'targetTipY'
  | 'originX'
  | 'originY'
  | 'cornerY'
> {
  return {
    tipX: 1,
    tipY: 0,
    targetTipX: 1,
    targetTipY: 0,
    originX: 1,
    originY: 0,
    cornerY: 0,
  };
}

export function useFlipGesture(options: FlipGestureOptions): FlipGestureHandles {
  const {
    onCommit,
    onTapCentre,
    onThresholdCrossed,
    onScaleChange,
    canTurn,
    layoutRef,
    rtl = false,
    reducedMotion = false,
  } = options;

  const state = useRef<FlipState>({
    progress: 0,
    target: 0,
    ...idleTip(),
    ndcX: null,
    ndcY: null,
    dragging: false,
    settling: false,
    direction: null,
    springImpulse: 0,
    scale: 1,
    panX: 0,
    panY: 0,
  });

  const setNdc = useCallback((clientX: number, clientY: number) => {
    const s = state.current;
    const w = Math.max(1, surfaceWidth.current);
    const h = Math.max(1, surfaceHeight.current);
    s.ndcX = ((clientX - surfaceLeft.current) / w) * 2 - 1;
    s.ndcY = -((clientY - surfaceTop.current) / h) * 2 + 1;
  }, []);

  const pointers = useRef(new Map<number, PointerRecord>());
  const surfaceWidth = useRef(1);
  const surfaceHeight = useRef(1);
  const surfaceLeft = useRef(0);
  const surfaceTop = useRef(0);
  const pinchStart = useRef<PinchStart | null>(null);
  const axisLock = useRef<'horizontal' | 'vertical' | null>(null);
  const crossedThreshold = useRef(false);
  const lastTap = useRef<TapSample | null>(null);
  /** Direction + corner locked for the active peel. */
  const peelLock = useRef<{
    direction: TurnDirection;
    cornerY: 0 | 1;
  } | null>(null);

  const callbacks = useRef({
    onCommit,
    onTapCentre,
    onThresholdCrossed,
    onScaleChange,
    canTurn,
  });
  useEffect(() => {
    callbacks.current = {
      onCommit,
      onTapCentre,
      onThresholdCrossed,
      onScaleChange,
      canTurn,
    };
  });

  const projectFinger = useCallback(
    (clientX: number, clientY: number) => {
      const layout = layoutRef.current;
      const s = state.current;
      if (
        layout &&
        layout.pageWidth > 0 &&
        layout.pageHeight > 0 &&
        layout.viewWidth > 0 &&
        layout.viewHeight > 0
      ) {
        return projectPointerToPage(
          clientX,
          clientY,
          surfaceLeft.current,
          surfaceTop.current,
          surfaceWidth.current,
          surfaceHeight.current,
          layout,
          s.scale,
          -s.panX / 200,
          s.panY / 200,
        );
      }
      // Layout not ready yet — full-canvas UV fallback.
      const x = (clientX - surfaceLeft.current) / Math.max(1, surfaceWidth.current);
      const y = 1 - (clientY - surfaceTop.current) / Math.max(1, surfaceHeight.current);
      return {
        x: Math.max(-0.5, Math.min(1.5, x)),
        y: Math.max(-0.2, Math.min(1.2, y)),
      };
    },
    [layoutRef],
  );

  const setScale = useCallback((next: number) => {
    const s = state.current;
    const clamped = clampScale(next);
    if (clamped === s.scale) return;
    s.scale = clamped;
    if (clamped <= 1.01) {
      s.panX = 0;
      s.panY = 0;
    } else {
      s.panX = clampPan(s.panX, clamped, surfaceWidth.current);
      s.panY = clampPan(s.panY, clamped, surfaceHeight.current);
    }
    callbacks.current.onScaleChange?.(clamped);
  }, []);

  const applyTipTarget = useCallback(
    (direction: TurnDirection, cornerY: 0 | 1, tipX: number, tipY: number) => {
      const s = state.current;
      const origin = restCorner(direction, rtl, cornerY);
      s.direction = direction;
      s.cornerY = cornerY;
      s.originX = origin.x;
      s.originY = origin.y;
      s.targetTipX = tipX;
      s.targetTipY = tipY;
      s.progress = progressFromTip(tipX, tipY, direction, rtl, cornerY);
      s.target = s.progress;
      if (reducedMotion) {
        s.tipX = tipX;
        s.tipY = tipY;
      }
    },
    [reducedMotion, rtl],
  );

  const commit = useCallback(
    (direction: TurnDirection) => {
      const s = state.current;
      const cornerY = s.cornerY;
      const origin = restCorner(direction, rtl, cornerY);
      const done = completeTip(direction, rtl, s.targetTipY || s.tipY || 0.35);
      s.settling = true;
      s.dragging = false;
      s.ndcX = null;
      s.ndcY = null;
      s.direction = direction;
      s.cornerY = cornerY;
      s.originX = origin.x;
      s.originY = origin.y;
      s.targetTipX = done.x;
      s.targetTipY = done.y;
      s.target = direction === 'next' ? 1 : -1;
      s.springImpulse = 0;
      if (reducedMotion) {
        s.tipX = done.x;
        s.tipY = done.y;
        s.progress = s.target;
      }
    },
    [reducedMotion, rtl],
  );

  const cancelTurn = useCallback(() => {
    const s = state.current;
    const direction = s.direction ?? peelLock.current?.direction ?? 'next';
    const cornerY = s.cornerY;
    const origin = restCorner(direction, rtl, cornerY);
    s.targetTipX = origin.x;
    s.targetTipY = origin.y;
    s.target = 0;
    s.settling = false;
    s.ndcX = null;
    s.ndcY = null;
    peelLock.current = null;
  }, [rtl]);

  const startTurn = useCallback(
    (direction: TurnDirection) => {
      const s = state.current;
      if (s.dragging || s.settling) return;
      if (!callbacks.current.canTurn(direction)) return;
      const cornerY: 0 | 1 = 0;
      const origin = restCorner(direction, rtl, cornerY);
      s.cornerY = cornerY;
      s.originX = origin.x;
      s.originY = origin.y;
      s.tipX = origin.x;
      s.tipY = origin.y;
      s.targetTipX = origin.x;
      s.targetTipY = 0.12;
      s.progress = 0;
      peelLock.current = { direction, cornerY };
      commit(direction);
    },
    [commit, rtl],
  );

  const resetZoom = useCallback(() => {
    const s = state.current;
    if (s.scale === 1 && s.panX === 0 && s.panY === 0) return;
    s.scale = 1;
    s.panX = 0;
    s.panY = 0;
    callbacks.current.onScaleChange?.(1);
  }, []);

  const nudgeScale = useCallback(
    (delta: number) => {
      setScale(state.current.scale + delta);
    },
    [setScale],
  );

  const getScale = useCallback(() => state.current.scale, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const s = state.current;
      if (s.settling) return;

      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect?.();
      surfaceWidth.current = target.clientWidth || 1;
      surfaceHeight.current = target.clientHeight || 1;
      surfaceLeft.current = rect?.left ?? 0;
      surfaceTop.current = rect?.top ?? 0;
      target.setPointerCapture?.(e.pointerId);

      const now = performance.now();
      pointers.current.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        startTime: now,
        lastX: e.clientX,
        lastY: e.clientY,
        lastTime: now,
        velocityX: 0,
        velocityY: 0,
      });

      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        if (a && b) {
          pinchStart.current = {
            distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
            scale: s.scale,
            midX: (a.x + b.x) / 2,
            midY: (a.y + b.y) / 2,
            panX: s.panX,
            panY: s.panY,
          };
        }
        s.dragging = false;
        cancelTurn();
        axisLock.current = null;
        peelLock.current = null;
      } else {
        s.dragging = true;
        axisLock.current = null;
        crossedThreshold.current = false;
        peelLock.current = null;
        setNdc(e.clientX, e.clientY);
      }
    },
    [cancelTurn, setNdc],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = state.current;
      const record = pointers.current.get(e.pointerId);
      if (!record) return;

      const prevX = record.x;
      const prevY = record.y;
      const now = performance.now();
      const dt = Math.max(1, now - record.lastTime);
      record.velocityX = (e.clientX - record.lastX) / dt;
      record.velocityY = (e.clientY - record.lastY) / dt;
      record.lastX = e.clientX;
      record.lastY = e.clientY;
      record.lastTime = now;
      record.x = e.clientX;
      record.y = e.clientY;

      if (pointers.current.size === 2 && pinchStart.current) {
        const [a, b] = [...pointers.current.values()];
        if (!a || !b) return;
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const next = (distance / pinchStart.current.distance) * pinchStart.current.scale;
        const scale = clampScale(next);
        s.scale = scale;
        s.panX = clampPan(
          pinchStart.current.panX + (midX - pinchStart.current.midX),
          scale,
          surfaceWidth.current,
        );
        s.panY = clampPan(
          pinchStart.current.panY + (midY - pinchStart.current.midY),
          scale,
          surfaceHeight.current,
        );
        callbacks.current.onScaleChange?.(scale);
        return;
      }

      if (s.scale > 1.01) {
        s.panX = clampPan(s.panX + (e.clientX - prevX), s.scale, surfaceWidth.current);
        s.panY = clampPan(s.panY + (e.clientY - prevY), s.scale, surfaceHeight.current);
        return;
      }

      if (!s.dragging || s.settling) return;

      const dx = e.clientX - record.startX;
      const dy = e.clientY - record.startY;

      if (axisLock.current === null) {
        if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > PAN_LOCKOUT_PX) {
          // Any peel-ish drag counts — Apple Books allows diagonal corner lifts.
          const cornerish =
            Math.abs(dx) > TAP_SLOP_PX * 0.5 ||
            (Math.abs(dy) > TAP_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 0.25);
          axisLock.current = cornerish || Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
        } else {
          setNdc(e.clientX, e.clientY);
          return;
        }
      }
      if (axisLock.current === 'vertical') return;

      setNdc(e.clientX, e.clientY);
      const finger = projectFinger(e.clientX, e.clientY);

      // Lock corner from touch half (demo: isRight / isTop) — fold axis stays dynamic.
      if (!peelLock.current) {
        const isRight = finger.x >= 0.5;
        const cornerY = cornerYFromPointer(finger.y);
        const direction: TurnDirection = rtl
          ? isRight
            ? 'prev'
            : 'next'
          : isRight
            ? 'next'
            : 'prev';
        const origin = restCorner(direction, rtl, cornerY);
        peelLock.current = { direction, cornerY };
        s.tipX = origin.x;
        s.tipY = origin.y;
        s.originX = origin.x;
        s.originY = origin.y;
        s.cornerY = cornerY;
        s.direction = direction;
        // Seed target from the projected finger; Raycaster refines each frame.
        s.targetTipX = finger.x;
        s.targetTipY = finger.y;
      }

      const { direction, cornerY } = peelLock.current;
      const origin = restCorner(direction, rtl, cornerY);

      if (!callbacks.current.canTurn(direction)) {
        applyTipTarget(
          direction,
          cornerY,
          origin.x + (finger.x - origin.x) * 0.12,
          origin.y + (finger.y - origin.y) * 0.12,
        );
        s.ndcX = null;
        s.ndcY = null;
        return;
      }

      // Progress from current tip; world target comes from Raycaster in FlipScene.
      s.direction = direction;
      s.cornerY = cornerY;
      s.originX = origin.x;
      s.originY = origin.y;
      s.progress = progressFromTip(s.tipX, s.tipY, direction, rtl, cornerY);
      s.target = s.progress;

      if (!crossedThreshold.current && Math.abs(s.progress) >= COMMIT_THRESHOLD) {
        crossedThreshold.current = true;
        callbacks.current.onThresholdCrossed?.();
      }
    },
    [applyTipTarget, projectFinger, rtl, setNdc],
  );

  const endPointer = useCallback(
    (e: React.PointerEvent) => {
      const s = state.current;
      const record = pointers.current.get(e.pointerId);
      pointers.current.delete(e.pointerId);
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

      if (pointers.current.size < 2) pinchStart.current = null;
      if (!record) return;
      if (pointers.current.size > 0) return;

      const dx = record.x - record.startX;
      const dy = record.y - record.startY;
      const elapsed = performance.now() - record.startTime;
      const travelled = Math.hypot(dx, dy);

      s.dragging = false;
      s.ndcX = null;
      s.ndcY = null;

      if (travelled < TAP_SLOP_PX && elapsed < TAP_MAX_MS) {
        // Treat as tap — cancel any tentative peel.
        if (peelLock.current) cancelTurn();
        const width = surfaceWidth.current;
        const localX = record.x - surfaceLeft.current;
        const zone = tapZone(localX, width);
        const sample: TapSample = {
          time: performance.now(),
          x: record.x,
          y: record.y,
        };

        if (zone === 'centre' && isDoubleTap(lastTap.current, sample)) {
          lastTap.current = null;
          if (s.scale > 1.01) {
            setScale(1);
          } else {
            const scale = DOUBLE_TAP_ZOOM;
            const midX = surfaceLeft.current + width / 2;
            const midY = surfaceTop.current + surfaceHeight.current / 2;
            s.panX = clampPan((midX - record.x) * (scale - 1), scale, width);
            s.panY = clampPan((midY - record.y) * (scale - 1), scale, surfaceHeight.current);
            setScale(scale);
          }
          peelLock.current = null;
          return;
        }

        lastTap.current = sample;

        if (s.scale > 1.01) {
          if (zone === 'centre') callbacks.current.onTapCentre();
          peelLock.current = null;
          return;
        }

        if (zone === 'left') {
          const dir: TurnDirection = rtl ? 'next' : 'prev';
          if (callbacks.current.canTurn(dir)) startTurn(dir);
        } else if (zone === 'right') {
          const dir: TurnDirection = rtl ? 'prev' : 'next';
          if (callbacks.current.canTurn(dir)) startTurn(dir);
        } else {
          callbacks.current.onTapCentre();
        }
        peelLock.current = null;
        return;
      }

      if (axisLock.current !== 'horizontal' || !s.direction || !peelLock.current) {
        cancelTurn();
        return;
      }

      const direction = peelLock.current.direction;
      const cornerY = peelLock.current.cornerY;
      const travel = tipTravel(s.targetTipX, s.targetTipY, direction, rtl, cornerY);

      const flicked =
        Math.abs(record.velocityX) > FLICK_VELOCITY ||
        (Math.abs(record.velocityY) > FLICK_VELOCITY && travel > 0.12);
      const flickForward = rtl ? record.velocityX > 0 : record.velocityX < 0;
      const directionIsNext = direction === 'next';
      const flickOk = flicked && flickForward === directionIsNext;

      // Commit when finger crossed mid-page (demo), threshold, or flick.
      const crossedMid =
        direction === 'next' ? s.targetTipX < 0.45 : s.targetTipX > 0.55;

      if (
        (Math.abs(s.progress) >= COMMIT_THRESHOLD ||
          flickOk ||
          travel > 0.42 ||
          crossedMid) &&
        callbacks.current.canTurn(direction)
      ) {
        // Keep vertical continuity into the settle.
        s.targetTipY = Math.min(0.92, Math.max(0.08, s.targetTipY));
        commit(direction);
      } else {
        cancelTurn();
      }

      peelLock.current = null;
    },
    [cancelTurn, commit, rtl, setScale, startTurn],
  );

  const bind = useMemo(
    () => ({
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
    }),
    [onPointerDown, onPointerMove, endPointer],
  );

  useEffect(() => {
    const clear = (): void => {
      pointers.current.clear();
      pinchStart.current = null;
      peelLock.current = null;
      state.current.dragging = false;
      cancelTurn();
    };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, [cancelTurn]);

  return { state, bind, startTurn, resetZoom, nudgeScale, getScale };
}

/**
 * Advance a spring one frame (tests / callers that still want a damped spring).
 */
export function stepSpring(
  current: number,
  target: number,
  velocity: number,
  deltaSeconds: number,
  stiffness = 240,
  damping = 26,
): { value: number; velocity: number } {
  const dt = Math.min(deltaSeconds, 1 / 30);

  const force = (target - current) * stiffness;
  const drag = velocity * damping;
  const nextVelocity = velocity + (force - drag) * dt;
  const nextValue = current + nextVelocity * dt;

  if (Math.abs(target - nextValue) < 0.001 && Math.abs(nextVelocity) < 0.01) {
    return { value: target, velocity: 0 };
  }
  return { value: nextValue, velocity: nextVelocity };
}
