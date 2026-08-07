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
  pointerToTip,
  progressFromTip,
  restCorner,
  tipTravel,
} from './pageCurlMath';

/**
 * Pointer handling for the reader surface.
 *
 * The animation state lives entirely in refs and is read by the render loop.
 * Tip (the curling page corner) follows the finger in page UV while dragging —
 * the same interaction model as Apple Books.
 */

export type TurnDirection = 'next' | 'prev';

/** Live animation state, mutated in place and read by `useFrame`. */
export interface FlipState {
  /** -1..1 derived from tip. Negative = prev, positive = next. */
  progress: number;
  /** Spring target for progress (used for reduced-motion / commit checks). */
  target: number;
  /** Curling corner tip in page UV (0..1, y: 0=bottom). */
  tipX: number;
  tipY: number;
  targetTipX: number;
  targetTipY: number;
  /** Rest corner for the active turn direction. */
  originX: number;
  originY: number;
  /** True while a finger is down and driving the tip directly. */
  dragging: boolean;
  /** Set once a release has been committed, to suppress duplicate commits. */
  settling: boolean;
  direction: TurnDirection | null;
  /**
   * One-shot spring velocity (progress units / second) applied on the first
   * post-release frame so flicks keep their momentum.
   */
  springImpulse: number;
  /** Pinch-zoom scale and pan offset, also read directly by the renderer. */
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
  'tipX' | 'tipY' | 'targetTipX' | 'targetTipY' | 'originX' | 'originY'
> {
  return {
    tipX: 1,
    tipY: 0,
    targetTipX: 1,
    targetTipY: 0,
    originX: 1,
    originY: 0,
  };
}

export function useFlipGesture(options: FlipGestureOptions): FlipGestureHandles {
  const {
    onCommit,
    onTapCentre,
    onThresholdCrossed,
    onScaleChange,
    canTurn,
    rtl = false,
    reducedMotion = false,
  } = options;

  const state = useRef<FlipState>({
    progress: 0,
    target: 0,
    ...idleTip(),
    dragging: false,
    settling: false,
    direction: null,
    springImpulse: 0,
    scale: 1,
    panX: 0,
    panY: 0,
  });

  const pointers = useRef(new Map<number, PointerRecord>());
  const surfaceWidth = useRef(1);
  const surfaceHeight = useRef(1);
  const surfaceLeft = useRef(0);
  const surfaceTop = useRef(0);
  const pinchStart = useRef<PinchStart | null>(null);
  const axisLock = useRef<'horizontal' | 'vertical' | null>(null);
  const crossedThreshold = useRef(false);
  const lastTap = useRef<TapSample | null>(null);

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

  const applyTip = useCallback(
    (direction: TurnDirection, tipX: number, tipY: number) => {
      const s = state.current;
      const origin = restCorner(direction, rtl);
      s.direction = direction;
      s.originX = origin.x;
      s.originY = origin.y;
      s.tipX = tipX;
      s.tipY = tipY;
      s.targetTipX = tipX;
      s.targetTipY = tipY;
      s.progress = progressFromTip(tipX, tipY, direction, rtl);
      s.target = s.progress;
    },
    [rtl],
  );

  const commit = useCallback(
    (direction: TurnDirection) => {
      const s = state.current;
      const origin = restCorner(direction, rtl);
      const done = completeTip(direction, rtl, s.tipY || 0.35);
      s.settling = true;
      s.direction = direction;
      s.originX = origin.x;
      s.originY = origin.y;
      s.targetTipX = done.x;
      s.targetTipY = done.y;
      s.target = direction === 'next' ? 1 : -1;
      if (s.springImpulse === 0) {
        s.springImpulse = direction === 'next' ? 5 : -5;
      }
      if (reducedMotion) {
        s.tipX = done.x;
        s.tipY = done.y;
        s.progress = s.target;
        s.springImpulse = 0;
      }
    },
    [reducedMotion, rtl],
  );

  const cancelTurn = useCallback(() => {
    const s = state.current;
    const direction = s.direction ?? 'next';
    const origin = restCorner(direction, rtl);
    s.targetTipX = origin.x;
    s.targetTipY = origin.y;
    s.target = 0;
    s.settling = false;
  }, [rtl]);

  const startTurn = useCallback(
    (direction: TurnDirection) => {
      const s = state.current;
      if (s.dragging || s.settling) return;
      if (!callbacks.current.canTurn(direction)) return;
      const origin = restCorner(direction, rtl);
      s.tipX = origin.x;
      s.tipY = origin.y;
      s.originX = origin.x;
      s.originY = origin.y;
      s.progress = 0;
      // Seed a natural peel height so tap-turns curl from the corner, not flat.
      s.tipY = 0.08;
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

  const onPointerDown = useCallback((e: React.PointerEvent) => {
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
    } else {
      s.dragging = true;
      axisLock.current = null;
      crossedThreshold.current = false;
    }
  }, [cancelTurn]);

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
          // Prefer horizontal, but allow a mostly-vertical peel from the corner
          // (Apple Books lets you drag up-left from the bottom-right).
          const cornerish =
            Math.abs(dx) > TAP_SLOP_PX * 0.6 ||
            (Math.abs(dy) > TAP_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 0.35);
          axisLock.current = cornerish || Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
        } else {
          return;
        }
      }
      if (axisLock.current === 'vertical') return;

      // Direction from initial horizontal intent (reading-order aware).
      const rawForward = rtl ? dx > 0 : dx < 0;
      const direction: TurnDirection = rawForward ? 'next' : 'prev';

      const finger = pointerToTip(
        e.clientX,
        e.clientY,
        surfaceLeft.current,
        surfaceTop.current,
        surfaceWidth.current,
        surfaceHeight.current,
      );
      const origin = restCorner(direction, rtl);
      // Grow the peel from the corner toward the finger so the first frames
      // are a small corner lift (Apple Books), not a sudden mid-page fold.
      const dragNorm =
        Math.hypot(dx, dy) /
        Math.max(1, Math.hypot(surfaceWidth.current, surfaceHeight.current));
      const grow = Math.min(1, dragNorm * 2.1 + 0.04);
      const tipX = origin.x + (finger.x - origin.x) * grow;
      const tipY = origin.y + (finger.y - origin.y) * grow;

      if (!callbacks.current.canTurn(direction)) {
        applyTip(
          direction,
          origin.x + (tipX - origin.x) * 0.12,
          origin.y + (tipY - origin.y) * 0.12,
        );
        return;
      }

      applyTip(direction, tipX, tipY);

      if (!crossedThreshold.current && Math.abs(s.progress) >= COMMIT_THRESHOLD) {
        crossedThreshold.current = true;
        callbacks.current.onThresholdCrossed?.();
      }
    },
    [applyTip, rtl],
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

      if (travelled < TAP_SLOP_PX && elapsed < TAP_MAX_MS) {
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
          return;
        }

        lastTap.current = sample;

        if (s.scale > 1.01) {
          if (zone === 'centre') callbacks.current.onTapCentre();
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
        return;
      }

      if (axisLock.current !== 'horizontal' || !s.direction) {
        cancelTurn();
        return;
      }

      const direction = s.direction;
      const travel = tipTravel(s.tipX, s.tipY, direction, rtl);
      const width = Math.max(1, surfaceWidth.current);
      const pxPerSec = record.velocityX * 1000;
      const impulse = Math.max(
        -14,
        Math.min(14, rtl ? pxPerSec / width : -pxPerSec / width),
      );
      s.springImpulse = impulse;

      const flicked =
        Math.abs(record.velocityX) > FLICK_VELOCITY ||
        (Math.abs(record.velocityY) > FLICK_VELOCITY && travel > 0.12);
      const flickForward = rtl ? record.velocityX > 0 : record.velocityX < 0;
      const directionIsNext = direction === 'next';
      const flickOk = flicked && flickForward === directionIsNext;

      if (
        (Math.abs(s.progress) >= COMMIT_THRESHOLD || flickOk || travel > 0.42) &&
        callbacks.current.canTurn(direction)
      ) {
        commit(direction);
      } else {
        cancelTurn();
      }
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
      state.current.dragging = false;
      cancelTurn();
    };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, [cancelTurn]);

  return { state, bind, startTurn, resetZoom };
}

/**
 * Advance a spring one frame (used for tip X/Y and legacy progress settle).
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
