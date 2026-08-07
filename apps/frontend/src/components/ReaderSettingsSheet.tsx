import { useEffect, useState } from 'react';
import {
  PAGE_ANIMATIONS,
  PAPER_PRESETS,
  type PageAnimation,
  type PaperPresetId,
  useReaderSettings,
} from '../store/reader';
import { useHaptics } from '../telegram/hooks';

/**
 * Apple Books–style Themes & Settings bottom sheet.
 *
 * Scale, page-turn animation, and paper themes. Opened by a centre tap while
 * reading; closed via the X or by tapping the dimmed backdrop.
 */

export interface ReaderSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  /** Current camera scale from the canvas (1 = fit). */
  scale: number;
  onNudgeScale: (delta: number) => void;
  pageIndex: number;
  pageCount: number;
  onScrubPage: (index: number) => void;
}

export function ReaderSettingsSheet({
  open,
  onClose,
  scale,
  onNudgeScale,
  pageIndex,
  pageCount,
  onScrubPage,
}: ReaderSettingsSheetProps): React.JSX.Element | null {
  const { impact } = useHaptics();
  const paperPreset = useReaderSettings((s) => s.paperPreset);
  const setPaperPreset = useReaderSettings((s) => s.setPaperPreset);
  const pageAnimation = useReaderSettings((s) => s.pageAnimation);
  const setPageAnimation = useReaderSettings((s) => s.setPageAnimation);
  const [animOpen, setAnimOpen] = useState(false);

  useEffect(() => {
    if (!open) setAnimOpen(false);
  }, [open]);

  if (!open) return null;

  const animLabel =
    PAGE_ANIMATIONS.find((a) => a.id === pageAnimation)?.label ?? 'Curl';

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Dismiss settings"
        className="absolute inset-0 bg-black/25"
        onClick={() => {
          impact('soft');
          onClose();
        }}
      />

      {/* Animation picker popover (Apple Books style). */}
      {animOpen && (
        <div className="pointer-events-auto absolute inset-x-0 bottom-[42%] z-50 flex justify-center px-6">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-[#f2f2f7]/95 shadow-2xl backdrop-blur-xl">
            <ul>
              {PAGE_ANIMATIONS.map((anim, i) => {
                const selected = pageAnimation === anim.id;
                return (
                  <li key={anim.id}>
                    <button
                      type="button"
                      onClick={() => {
                        impact('soft');
                        setPageAnimation(anim.id);
                        setAnimOpen(false);
                      }}
                      className={`flex w-full items-center gap-3 px-4 py-3.5 text-left ${
                        i > 0 ? 'border-t border-black/10' : ''
                      }`}
                    >
                      <span className="w-5 text-center text-sm text-[#007aff]">
                        {selected ? '✓' : ''}
                      </span>
                      <AnimationIcon id={anim.id} />
                      <span className="flex-1 text-[15px] font-medium text-[#1c1c1e]">
                        {anim.label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      <div className="pointer-events-auto relative mx-2 mb-2 max-h-[78%] overflow-y-auto rounded-[28px] bg-[#f2f2f7]/92 pb-safe shadow-2xl backdrop-blur-2xl">
        <header className="sticky top-0 z-10 flex items-center gap-3 bg-[#f2f2f7]/92 px-4 pb-3 pt-4 backdrop-blur-xl">
          <button
            type="button"
            aria-label="Close"
            onClick={() => {
              impact('light');
              onClose();
            }}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/10 text-lg font-medium text-[#1c1c1e]"
          >
            ×
          </button>
          <h2 className="flex-1 text-center text-[17px] font-semibold text-[#1c1c1e]">
            Themes & Settings
          </h2>
          <span className="w-9" />
        </header>

        <div className="space-y-5 px-4 pb-5">
          {/* Scale + animation entry */}
          <div className="flex gap-3">
            <div className="flex flex-1 items-center justify-between rounded-2xl bg-white px-2 py-1.5 shadow-sm">
              <button
                type="button"
                aria-label="Zoom out"
                disabled={scale <= 1.01}
                onClick={() => {
                  impact('soft');
                  onNudgeScale(-0.35);
                }}
                className="flex h-10 w-12 items-center justify-center rounded-xl text-[15px] font-semibold text-[#1c1c1e] disabled:opacity-35"
              >
                <span className="text-sm">A</span>
              </button>
              <span className="tabular-nums text-xs text-[#8e8e93]">
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                aria-label="Zoom in"
                disabled={scale >= 3.99}
                onClick={() => {
                  impact('soft');
                  onNudgeScale(0.35);
                }}
                className="flex h-10 w-12 items-center justify-center rounded-xl text-[22px] font-semibold text-[#1c1c1e] disabled:opacity-35"
              >
                A
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                impact('soft');
                setAnimOpen((v) => !v);
              }}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-white px-3 py-2 shadow-sm"
            >
              <AnimationIcon id={pageAnimation} />
              <span className="text-[15px] font-medium text-[#1c1c1e]">{animLabel}</span>
            </button>
          </div>

          {/* Theme grid */}
          <div className="grid grid-cols-3 gap-2.5">
            {PAPER_PRESETS.map((preset) => {
              const selected = paperPreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    impact('soft');
                    setPaperPreset(preset.id as PaperPresetId);
                  }}
                  className={`flex flex-col items-start rounded-2xl px-3 py-3 text-left transition-shadow ${
                    selected ? 'ring-[3px] ring-[#1c1c1e]' : 'ring-1 ring-black/10'
                  }`}
                  style={{ backgroundColor: preset.paperColor }}
                >
                  <span
                    className="text-[22px] font-serif leading-none"
                    style={{ color: preset.inkColor }}
                  >
                    Aa
                  </span>
                  <span
                    className="mt-2 text-[12px] font-medium"
                    style={{ color: preset.inkColor }}
                  >
                    {preset.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Page scrubber */}
          {pageCount > 1 && (
            <div className="rounded-2xl bg-white px-4 py-3 shadow-sm">
              <div className="mb-2 flex items-baseline justify-between text-xs text-[#8e8e93]">
                <span>Page</span>
                <span className="tabular-nums text-[#1c1c1e]">
                  {pageIndex + 1} / {pageCount}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={pageCount - 1}
                value={pageIndex}
                onChange={(e) => onScrubPage(Number(e.target.value))}
                aria-label="Page"
                className="w-full accent-[#1c1c1e]"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AnimationIcon({ id }: { id: PageAnimation }): React.JSX.Element {
  const common = 'h-5 w-5 text-[#1c1c1e]';
  switch (id) {
    case 'slide':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="5" width="12" height="14" rx="1.5" />
          <path d="M18 12H10m0 0 2.5-2.5M10 12l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'curl':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 4h9l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
          <path d="M15 4v5h5" />
        </svg>
      );
    case 'fade':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="5" y="5" width="14" height="14" rx="2" />
          <path d="M12 8v4l2 2" strokeLinecap="round" />
        </svg>
      );
    case 'scroll':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 6h10M7 12h10M7 18h7" strokeLinecap="round" />
        </svg>
      );
  }
}
