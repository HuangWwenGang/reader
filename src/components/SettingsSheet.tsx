import {
  THEME_LABELS,
  THEMES,
  type FlowMode,
  type Settings,
  type ThemeName,
} from '../lib/settings'

const THEME_ORDER: ThemeName[] = ['paper', 'sepia', 'night']

export default function SettingsSheet({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}) {
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />

        <div className="sheet-row">
          <span className="sheet-label">主题</span>
          <div className="seg">
            {THEME_ORDER.map((t) => (
              <button
                key={t}
                className={'seg-btn' + (settings.theme === t ? ' active' : '')}
                onClick={() => onChange({ theme: t })}
              >
                <span
                  className="theme-swatch"
                  style={{
                    background: THEMES[t].bg,
                    color: THEMES[t].ink,
                    borderColor: THEMES[t].line,
                  }}
                >
                  A
                </span>
                {THEME_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="sheet-row">
          <span className="sheet-label">排版</span>
          <div className="seg">
            {(['scrolled', 'paginated'] as FlowMode[]).map((f) => (
              <button
                key={f}
                className={'seg-btn' + (settings.flow === f ? ' active' : '')}
                onClick={() => onChange({ flow: f })}
              >
                {f === 'scrolled' ? '流式滚动' : '左右翻页'}
              </button>
            ))}
          </div>
        </div>

        <div className="sheet-row">
          <span className="sheet-label">字号</span>
          <div className="stepper">
            <button
              onClick={() =>
                onChange({ fontScale: Math.max(70, settings.fontScale - 10) })
              }
            >
              A−
            </button>
            <span className="stepper-value">{settings.fontScale}%</span>
            <button
              onClick={() =>
                onChange({ fontScale: Math.min(220, settings.fontScale + 10) })
              }
            >
              A+
            </button>
          </div>
        </div>

        <div className="sheet-row">
          <span className="sheet-label">行距</span>
          <div className="stepper">
            <button
              onClick={() =>
                onChange({
                  lineHeight: Math.max(1.2, +(settings.lineHeight - 0.1).toFixed(1)),
                })
              }
            >
              −
            </button>
            <span className="stepper-value">{settings.lineHeight.toFixed(1)}</span>
            <button
              onClick={() =>
                onChange({
                  lineHeight: Math.min(2.4, +(settings.lineHeight + 0.1).toFixed(1)),
                })
              }
            >
              +
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
