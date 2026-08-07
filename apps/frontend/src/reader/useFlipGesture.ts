import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  clampPan,
  clampScale,
  COMMIT_THRESHOLD,
  DOUBLE_TAP_ZOOM,
  dragToProgress,
  isDoubleTap,
  PAN_LOCKOUT_PX,
  shouldCommitTurn,
  TAP_MAX_MS,
  TAP_SLOP_PX,
  tapZone,
  type TapSample,
} from './gestureMath';

/**
 * Pointer handling for the reader surface.
 *
 * The animation state lives entirely in refs and is read by the render loop.
 * Nothing here calls `setState` during a drag: a React re-render mid-turn
 * would reconcile the whole reader subtree every frame and, worse, could
 * remount the canvas and drop every texture. State only escapes via the
 * `onCommit` callback once a turn resolves.
 */

export type TurnDirection = 'next' | 'prev';

/** Live animation state, mutated in place and read by `useFrame`. */
export interface FlipState {
  /** -1..1. Negative is a backward turn, positive forward. 0 is at rest. */
  progress: number;
  /** Spring target. The render loop eases `progress` toward this. */
  target: number;
  /** True while a finger is down and driving progress directly. */
  dragging: boolean;
  /** Set once a release has been committed, to suppress duplicate commits. */
  settling: boolean;
  direction: TurnDirection | null;
  /**
   * One-shot spring velocity (progress units / second) applied on the first
   * post-release frame so flicks keep their momentum instead of starting from 0.
   */
  springImpulse: number;
  /** Pinch-zoom scale and pan offset, also read directly by the renderer. */
  scale: number;
  panX: number;
  panY: number;
}

export interface FlipGestureOptions {
  /** Called when a turn completes and the page index should change. */
  onCommit: (direction: TurnDirection) => void;
  /** Tap in the centre band; used to toggle the reader chrome. */
  onTapCentre: () => void;
  /** Fired at the moment a turn passes the commit threshold. */
  onThresholdCrossed?: () => void;
  /** Fired when pinch / double-tap changes the zoom scale. */
  onScaleChange?: (scale: number) => void;
  /** Whether a turn in the given direction is currently possible. */
  canTurn: (direction: TurnDirection) => boolean;
  /** Right-to-left reading order swaps which edge advances. */
  rtl?: boolean;
  /** Disables 3D turns in favour of an instant change. */
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
  /** Start a turn programmatically, e.g. from a tap zone or a keyboard key. */
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
  velocity: number;
}

interface PinchStart {
  distance: number;
  scale: number;
  midX: number;
  midY: number;
  panX: number;
  panY: number;
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
    dragging: false,
    settling: false,
    direction: null,
    springImpulse: 0,
    scale: 1,
    panX: 0,
    panY: 0,
  });

  /** Active pointers, keyed by pointerId, so pinch can track two at once. */
  const pointers = useRef(new Map<number, PointerRecord>());
  const surfaceWidth = useRef(1);
  const surfaceHeight = useRef(1);
  /** Distance / midpoint snapshot when a pinch began. */
  const pinchStart = useRef<PinchStart | null>(null);
  /** Set once per drag when the direction has been decided. */
  const axisLock = useRef<'horizontal' | 'vertical' | null>(null);
  const crossedThreshold = useRef(false);
  const lastTap = useRef<TapSample | null>(null);

  // Latest callbacks without re-binding the handlers every render.
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

  const commit = useCallback(
    (direction: TurnDirection) => {
      const s = state.current;
      s.settling = true;
      s.direction = direction;
      s.target = direction === 'next' ? 1 : -1;
      // Tap / keyboard turns have no finger velocity — give a modest push so
      // the spring does not crawl from a dead stop.
      if (s.springImpulse === 0) {
        s.springImpulse = direction === 'next' ? 4 : -4;
      }
      if (reducedMotion) {
        // Skip the animation entirely and hand control back immediately.
        s.progress = s.target;
        s.springImpulse = 0;
      }
    },
    [reducedMotion],
  );

  const startTurn = useCallback(
    (direction: TurnDirection) => {
      const s = state.current;
      if (s.dragging || s.settling) return;
      if (!callbacks.current.canTurn(direction)) return;
      commit(direction);
    },
    [commit],
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
    surfaceWidth.current = target.clientWidth || 1;
    surfaceHeight.current = target.clientHeight || 1;
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
      velocity: 0,
    });

    if (pointers.current.size === 2) {
      // Second finger down: this is a pinch, so abandon any turn in progress.
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
      s.target = 0;
      axisLock.current = null;
    } else {
      s.dragging = true;
      axisLock.current = null;
      crossedThreshold.current = false;
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = state.current;
      const record = pointers.current.get(e.pointerId);
      if (!record) return;

      const prevX = record.x;
      const prevY = record.y;
      const now = performance.now();
      const dt = Math.max(1, now - record.lastTime);
      record.velocity = (e.clientX - record.lastX) / dt;
      record.lastX = e.clientX;
      record.lastY = e.clientY;
      record.lastTime = now;
      record.x = e.clientX;
      record.y = e.clientY;

      // Two fingers: pinch to zoom and pan with the midpoint.
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

      // One finger while zoomed in: pan by the frame-to-frame delta.
      if (s.scale > 1.01) {
        s.panX = clampPan(s.panX + (e.clientX - prevX), s.scale, surfaceWidth.current);
        s.panY = clampPan(s.panY + (e.clientY - prevY), s.scale, surfaceHeight.current);
        return;
      }

      if (!s.dragging || s.settling) return;

      const dx = e.clientX - record.startX;
      const dy = e.clientY - record.startY;

      // Decide once whether this gesture is a turn or a vertical pan, then stick
      // with it. Re-deciding mid-drag makes diagonal swipes feel like they stick.
      if (axisLock.current === null) {
        if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > PAN_LOCKOUT_PX) {
          axisLock.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
        } else {
          return;
        }
      }
      if (axisLock.current === 'vertical') return;

      const signed = dragToProgress(dx, surfaceWidth.current, rtl);
      const direction: TurnDirection = signed > 0 ? 'next' : 'prev';

      if (!callbacks.current.canTurn(direction)) {
        // At the first or last page, resist rather than showing an empty turn.
        s.progress = signed * 0.12;
        return;
      }

      s.progress = signed;
      s.target = s.progress;
      s.direction = direction;

      if (!crossedThreshold.current && Math.abs(s.progress) >= COMMIT_THRESHOLD) {
        crossedThreshold.current = true;
        callbacks.current.onThresholdCrossed?.();
      }
    },
    [rtl],
  );

  const endPointer = useCallback(
    (e: React.PointerEvent) => {
      const s = state.current;
      const record = pointers.current.get(e.pointerId);
      pointers.current.delete(e.pointerId);
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

      if (pointers.current.size < 2) pinchStart.current = null;
      if (!record) return;
      // Wait for both fingers to lift before resolving anything.
      if (pointers.current.size > 0) return;

      const dx = record.x - record.startX;
      const dy = record.y - record.startY;
      const elapsed = performance.now() - record.startTime;
      const travelled = Math.hypot(dx, dy);

      s.dragging = false;

      // A short, still press is a tap. Centre double-tap toggles zoom; edge
      // thirds turn the page; a single centre tap toggles chrome.
      if (travelled < TAP_SLOP_PX && elapsed < TAP_MAX_MS) {
        const width = surfaceWidth.current;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect?.();
        const localX = record.x - (rect?.left ?? 0);
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
            // Pan toward the tap so the point under the finger stays roughly
            // centred after the jump to DOUBLE_TAP_ZOOM.
            const scale = DOUBLE_TAP_ZOOM;
            const midX = (rect?.left ?? 0) + width / 2;
            const midY = (rect?.top ?? 0) + surfaceHeight.current / 2;
            s.panX = clampPan((midX - record.x) * (scale - 1), scale, width);
            s.panY = clampPan((midY - record.y) * (scale - 1), scale, surfaceHeight.current);
            setScale(scale);
          }
          return;
        }

        lastTap.current = sample;

        // While zoomed, a single tap does not turn pages — only double-tap /
        // pinch / resetZoom leave the zoomed state.
        if (s.scale > 1.01) {
          if (zone === 'centre') callbacks.current.onTapCentre();
          return;
        }

        if (zone === 'left') {
          const dir: TurnDirection = rtl ? 'next' : 'prev';
          if (callbacks.current.canTurn(dir)) commit(dir);
        } else if (zone === 'right') {
          const dir: TurnDirection = rtl ? 'prev' : 'next';
          if (callbacks.current.canTurn(dir)) commit(dir);
        } else {
          callbacks.current.onTapCentre();
        }
        return;
      }

      if (axisLock.current !== 'horizontal' || s.progress === 0) {
        s.target = 0;
        return;
      }

      // Convert finger velocity (px/ms) → spring velocity (progress / s).
      const width = Math.max(1, surfaceWidth.current);
      const pxPerSec = record.velocity * 1000;
      const impulse = Math.max(
        -12,
        Math.min(12, rtl ? pxPerSec / width : -pxPerSec / width),
      );
      s.springImpulse = impulse;

      const direction: TurnDirection = s.progress > 0 ? 'next' : 'prev';
      if (
        shouldCommitTurn(s.progress, record.velocity, rtl) &&
        callbacks.current.canTurn(direction)
      ) {
        commit(direction);
      } else {
        s.target = 0; // spring back with the leftover finger velocity
      }
    },
    [commit, rtl, setScale],
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

  // A pointercancel from the OS (an incoming call, the app being backgrounded)
  // leaves stale entries behind, which would make the next touch look like a
  // pinch. Clear them whenever the document loses visibility.
  useEffect(() => {
    const clear = (): void => {
      pointers.current.clear();
      pinchStart.current = null;
      state.current.dragging = false;
      state.current.target = 0;
    };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);

  return { state, bind, startTurn, resetZoom };
}

/**
 * Advance a spring one frame.
 *
 * A critically damped spring rather than a fixed-duration easing: the turn has
 * to start from whatever progress the finger left it at, with whatever
 * velocity, and an easing curve cannot do that without a visible jump.
 */
export function stepSpring(
  current: number,
  target: number,
  velocity: number,
  deltaSeconds: number,
  stiffness = 210,
  damping = 24,
): { value: number; velocity: number } {
  // Clamp the timestep. A backgrounded tab resumes with a huge delta, and an
  // unclamped spring integrates that into a violent overshoot.
  const dt = Math.min(deltaSeconds, 1 / 30);

  const force = (target - current) * stiffness;
  const drag = velocity * damping;
  const nextVelocity = velocity + (force - drag) * dt;
  const nextValue = current + nextVelocity * dt;

  // Snap when close enough that further frames would be invisible.
  if (Math.abs(target - nextValue) < 0.001 && Math.abs(nextVelocity) < 0.01) {
    return { value: target, velocity: 0 };
  }
  return { value: nextValue, velocity: nextVelocity };
}
