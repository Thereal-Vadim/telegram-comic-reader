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
 * Reader settings sheet — same visual language as the rest of the Mini App.
 *
 * Uses Telegram theme tokens (`tg-bg`, `tg-secondary-bg`, `tg-button`, …),
 * `rounded-xl` panels, and uppercase section labels — not an iOS Books clone.
 */

export interface ReaderSettingsSheetProps {
  open: boolean;
  onClose: () => void;
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

  const animMeta = PAGE_ANIMATIONS.find((a) => a.id === pageAnimation);

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Dismiss settings"
        className="absolute inset-0 bg-black/50"
        onClick={() => {
          impact('soft');
          onClose();
        }}
      />

      <div className="pointer-events-auto relative max-h-[80%] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-tg-bg/95 pb-safe shadow-[0_-8px_32px_rgba(0,0,0,0.45)] backdrop-blur supports-[backdrop-filter]:bg-tg-bg/90">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/5 bg-tg-bg/95 px-4 py-3 backdrop-blur">
          <button
            type="button"
            onClick={() => {
              impact('light');
              onClose();
            }}
            className="rounded-lg bg-tg-secondary-bg px-3 py-1.5 text-sm font-medium text-tg-text"
          >
            Close
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-bold text-tg-text">Reading settings</h2>
            <p className="truncate text-[11px] text-tg-hint">Scale, turn style, and paper</p>
          </div>
        </header>

        <div className="space-y-6 px-4 py-4">
          {/* Scale */}
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
              Scale
            </h3>
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-tg-secondary-bg p-2">
              <button
                type="button"
                aria-label="Zoom out"
                disabled={scale <= 1.01}
                onClick={() => {
                  impact('soft');
                  onNudgeScale(-0.35);
                }}
                className="rounded-lg bg-black/25 px-4 py-2.5 text-sm font-semibold text-tg-text disabled:opacity-40"
              >
                −
              </button>
              <div className="min-w-0 flex-1 text-center">
                <p className="tabular-nums text-sm font-semibold text-tg-text">
                  {Math.round(scale * 100)}%
                </p>
                <p className="text-[11px] text-tg-hint">Pinch or double-tap also zooms</p>
              </div>
              <button
                type="button"
                aria-label="Zoom in"
                disabled={scale >= 3.99}
                onClick={() => {
                  impact('soft');
                  onNudgeScale(0.35);
                }}
                className="rounded-lg bg-black/25 px-4 py-2.5 text-sm font-semibold text-tg-text disabled:opacity-40"
              >
                +
              </button>
            </div>
          </section>

          {/* Page animation */}
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
              Page turn
            </h3>
            <button
              type="button"
              onClick={() => {
                impact('soft');
                setAnimOpen((v) => !v);
              }}
              className="mt-2 flex w-full items-center gap-3 rounded-xl bg-tg-secondary-bg px-3 py-3 text-left"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-black/25 text-tg-link">
                <AnimationIcon id={pageAnimation} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-tg-text">
                  {animMeta?.label ?? 'Curl'}
                </span>
                <span className="block text-xs text-tg-hint">
                  {animMeta?.description ?? 'Page animation'}
                </span>
              </span>
              <span className="text-xs text-tg-link">{animOpen ? 'Hide' : 'Change'}</span>
            </button>

            {animOpen && (
              <ul className="mt-2 overflow-hidden rounded-xl bg-tg-secondary-bg">
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
                        className={`flex w-full items-center gap-3 px-3 py-3 text-left ${
                          i > 0 ? 'border-t border-white/5' : ''
                        } ${selected ? 'bg-tg-button/15' : ''}`}
                      >
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/25 text-tg-text">
                          <AnimationIcon id={anim.id} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-tg-text">
                            {anim.label}
                          </span>
                          <span className="block text-xs text-tg-hint">{anim.description}</span>
                        </span>
                        {selected && (
                          <span className="text-xs font-semibold text-tg-link">On</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Paper / ambient themes */}
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
              Background
            </h3>
            <div className="mt-2 grid grid-cols-3 gap-2">
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
                    className={`overflow-hidden rounded-xl text-left transition-shadow ${
                      selected
                        ? 'ring-2 ring-tg-button ring-offset-2 ring-offset-tg-bg'
                        : 'ring-1 ring-white/10'
                    }`}
                  >
                    <span
                      className="flex aspect-[4/3] items-end px-2.5 pb-2 pt-3"
                      style={{ backgroundColor: preset.paperColor }}
                    >
                      <span
                        className="text-lg font-semibold leading-none"
                        style={{ color: preset.inkColor }}
                      >
                        Aa
                      </span>
                    </span>
                    <span className="block bg-tg-secondary-bg px-2.5 py-1.5 text-[11px] font-medium text-tg-text">
                      {preset.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Page scrubber */}
          {pageCount > 1 && (
            <section>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-tg-subtitle">
                Jump to page
              </h3>
              <div className="mt-2 rounded-xl bg-tg-secondary-bg px-3 py-3">
                <div className="mb-2 flex items-baseline justify-between text-xs">
                  <span className="text-tg-hint">Page</span>
                  <span className="tabular-nums font-medium text-tg-text">
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
                  className="w-full accent-tg-button"
                />
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function AnimationIcon({ id }: { id: PageAnimation }): React.JSX.Element {
  const common = 'h-4 w-4';
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
