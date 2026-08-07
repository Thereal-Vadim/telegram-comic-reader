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
 * Reader settings sheet.
 *
 * Surface is fixed pure white so Telegram’s warm light `bg_color` cannot tint
 * the panel beige. Inner cards use cool neutrals; text stays dark for contrast
 * in both Telegram light and dark client themes.
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
        className="absolute inset-0 bg-black/40"
        onClick={() => {
          impact('soft');
          onClose();
        }}
      />

      <div className="pointer-events-auto relative max-h-[80%] overflow-y-auto rounded-t-2xl border-t border-neutral-200 bg-white pb-safe shadow-[0_-8px_32px_rgba(0,0,0,0.25)]">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-neutral-100 bg-white px-4 py-3">
          <button
            type="button"
            onClick={() => {
              impact('light');
              onClose();
            }}
            className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900"
          >
            Close
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-bold text-neutral-900">Reading settings</h2>
            <p className="truncate text-[11px] text-neutral-500">Scale, turn style, and paper</p>
          </div>
        </header>

        <div className="space-y-6 px-4 py-4">
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Scale
            </h3>
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-neutral-100 p-2">
              <button
                type="button"
                aria-label="Zoom out"
                disabled={scale <= 1.01}
                onClick={() => {
                  impact('soft');
                  onNudgeScale(-0.35);
                }}
                className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 shadow-sm disabled:opacity-40"
              >
                −
              </button>
              <div className="min-w-0 flex-1 text-center">
                <p className="tabular-nums text-sm font-semibold text-neutral-900">
                  {Math.round(scale * 100)}%
                </p>
                <p className="text-[11px] text-neutral-500">Pinch or double-tap also zooms</p>
              </div>
              <button
                type="button"
                aria-label="Zoom in"
                disabled={scale >= 3.99}
                onClick={() => {
                  impact('soft');
                  onNudgeScale(0.35);
                }}
                className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 shadow-sm disabled:opacity-40"
              >
                +
              </button>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Page turn
            </h3>
            <button
              type="button"
              onClick={() => {
                impact('soft');
                setAnimOpen((v) => !v);
              }}
              className="mt-2 flex w-full items-center gap-3 rounded-xl bg-neutral-100 px-3 py-3 text-left"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-tg-button shadow-sm">
                <AnimationIcon id={pageAnimation} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-neutral-900">
                  {animMeta?.label ?? 'Curl'}
                </span>
                <span className="block text-xs text-neutral-500">
                  {animMeta?.description ?? 'Page animation'}
                </span>
              </span>
              <span className="text-xs font-medium text-tg-button">
                {animOpen ? 'Hide' : 'Change'}
              </span>
            </button>

            {animOpen && (
              <ul className="mt-2 overflow-hidden rounded-xl bg-neutral-100">
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
                          i > 0 ? 'border-t border-neutral-200/80' : ''
                        } ${selected ? 'bg-tg-button/10' : ''}`}
                      >
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-neutral-900 shadow-sm">
                          <AnimationIcon id={anim.id} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-neutral-900">
                            {anim.label}
                          </span>
                          <span className="block text-xs text-neutral-500">{anim.description}</span>
                        </span>
                        {selected && (
                          <span className="text-xs font-semibold text-tg-button">On</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
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
                        ? 'ring-2 ring-neutral-900 ring-offset-2 ring-offset-white'
                        : 'ring-1 ring-neutral-200'
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
                    <span className="block bg-neutral-50 px-2.5 py-1.5 text-[11px] font-medium text-neutral-900">
                      {preset.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {pageCount > 1 && (
            <section>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                Jump to page
              </h3>
              <div className="mt-2 rounded-xl bg-neutral-100 px-3 py-3">
                <div className="mb-2 flex items-baseline justify-between text-xs">
                  <span className="text-neutral-500">Page</span>
                  <span className="tabular-nums font-medium text-neutral-900">
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
