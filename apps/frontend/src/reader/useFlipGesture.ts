import { useCallback, useEffect, useMemo, useRef } from 'react';

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
  /** Whether a turn in the given direction is currently possible. */
  canTurn: (direction: TurnDirection) => boolean;
  /** Right-to-left reading order swaps which edge advances. */
  rtl?: boolean;
  /** Disables 3D turns in favour of an instant change. */
  reducedMotion?: boolean;
}

/** Fraction of the page width a drag must cross to commit rather than snap back. */
const COMMIT_THRESHOLD = 0.28;
/** Flick speed (px/ms) that commits regardless of distance travelled. */
const FLICK_VELOCITY = 0.45;
/** Vertical travel beyond which we treat the gesture as a pan, not a turn. */
const PAN_LOCKOUT_PX = 24;
/** Movement below this is a tap, not a drag. */
const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 300;

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
  lastTime: number;
  velocity: number;
}

export function useFlipGesture(options: FlipGestureOptions): FlipGestureHandles {
  const {
    onCommit,
    onTapCentre,
    onThresholdCrossed,
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
    scale: 1,
    panX: 0,
    panY: 0,
  });

  /** Active pointers, keyed by pointerId, so pinch can track two at once. */
  const pointers = useRef(new Map<number, PointerRecord>());
  const surfaceWidth = useRef(1);
  /** Distance between the two fingers when a pinch began. */
  const pinchStart = useRef<{ distance: number; scale: number } | null>(null);
  /** Set once per drag when the direction has been decided. */
  const axisLock = useRef<'horizontal' | 'vertical' | null>(null);
  const crossedThreshold = useRef(false);

  // Latest callbacks without re-binding the handlers every render.
  const callbacks = useRef({ onCommit, onTapCentre, onThresholdCrossed, canTurn });
  useEffect(() => {
    callbacks.current = { onCommit, onTapCentre, onThresholdCrossed, canTurn };
  });

  const commit = useCallback(
    (direction: TurnDirection) => {
      const s = state.current;
      s.settling = true;
      s.direction = direction;
      s.target = direction === 'next' ? 1 : -1;
      if (reducedMotion) {
        // Skip the animation entirely and hand control back immediately.
        s.progress = s.target;
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
    s.scale = 1;
    s.panX = 0;
    s.panY = 0;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const s = state.current;
    if (s.settling) return;

    surfaceWidth.current = e.currentTarget.clientWidth || 1;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);

    const now = performance.now();
    pointers.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      startTime: now,
      lastX: e.clientX,
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

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = state.current;
    const record = pointers.current.get(e.pointerId);
    if (!record) return;

    const now = performance.now();
    const dt = Math.max(1, now - record.lastTime);
    record.velocity = (e.clientX - record.lastX) / dt;
    record.lastX = e.clientX;
    record.lastTime = now;
    record.x = e.clientX;
    record.y = e.clientY;

    // Two fingers: pinch to zoom, and pan with the midpoint.
    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const next = (distance / pinchStart.current.distance) * pinchStart.current.scale;
      // Clamped: below 1 there is nothing to see, above 4 the zoom texture is
      // being magnified past its own resolution.
      s.scale = Math.min(4, Math.max(1, next));
      return;
    }

    // One finger while zoomed in: pan rather than turn.
    if (s.scale > 1.01) {
      s.panX += e.clientX - (record.startX + s.panX);
      s.panY += e.clientY - (record.startY + s.panY);
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

    // Drag maps 1:1 onto progress across the page width. Dragging leftwards
    // (negative dx) advances in left-to-right reading order.
    const raw = -dx / surfaceWidth.current;
    const signed = rtl ? -raw : raw;
    const direction: TurnDirection = signed > 0 ? 'next' : 'prev';

    if (!callbacks.current.canTurn(direction)) {
      // At the first or last page, resist rather than showing an empty turn.
      s.progress = signed * 0.12;
      return;
    }

    s.progress = Math.max(-1, Math.min(1, signed));
    s.target = s.progress;
    s.direction = direction;

    if (!crossedThreshold.current && Math.abs(s.progress) >= COMMIT_THRESHOLD) {
      crossedThreshold.current = true;
      callbacks.current.onThresholdCrossed?.();
    }
  }, [rtl]);

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

      // A short, still press is a tap. Which third it lands in decides what
      // it does; the caller supplies the centre behaviour.
      if (travelled < TAP_SLOP_PX && elapsed < TAP_MAX_MS && s.scale <= 1.01) {
        const width = surfaceWidth.current;
        const third = width / 3;
        const x = record.x - ((e.currentTarget as HTMLElement).getBoundingClientRect?.().left ?? 0);

        if (x < third) {
          const dir: TurnDirection = rtl ? 'next' : 'prev';
          if (callbacks.current.canTurn(dir)) commit(dir);
        } else if (x > width - third) {
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

      // A fast flick commits even if it did not travel far, which is what
      // makes rapid page-turning feel responsive rather than sluggish.
      const flickForward = rtl ? record.velocity > 0 : record.velocity < 0;
      const flicked = Math.abs(record.velocity) > FLICK_VELOCITY;
      const direction: TurnDirection = s.progress > 0 ? 'next' : 'prev';
      const flickAgrees = flicked && (flickForward ? direction === 'next' : direction === 'prev');

      if ((Math.abs(s.progress) >= COMMIT_THRESHOLD || flickAgrees) && callbacks.current.canTurn(direction)) {
        commit(direction);
      } else {
        s.target = 0; // spring back
      }
    },
    [commit, rtl],
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
  stiffness = 170,
  damping = 26,
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
