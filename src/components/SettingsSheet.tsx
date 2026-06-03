import { useEffect } from 'react'
import {
  FONT_LABELS,
  THEME_LABELS,
  THEMES,
  type FontKey,
  type Settings,
  type ThemeName,
} from '../lib/settings'

const THEME_ORDER: ThemeName[] = ['paper', 'sepia', 'night']
const FONT_ORDER: FontKey[] = ['default', 'sans', 'serif']

function Stepper({
  value,
  onDec,
  onInc,
  dec = '−',
  inc = '+',
}: {
  value: string
  onDec: () => void
  onInc: () => void
  dec?: string
  inc?: string
}) {
  return (
    <div className="stepper">
      <button onClick={onDec}>{dec}</button>
      <span className="stepper-value">{value}</span>
      <button onClick={onInc}>{inc}</button>
    </div>
  )
}

export default function SettingsSheet({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}) {
  useEffect(() => {
    document.documentElement.classList.add('overlay-open')
    return () => document.documentElement.classList.remove('overlay-open')
  }, [])

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
          <span className="sheet-label">字体</span>
          <div className="seg">
            {FONT_ORDER.map((f) => (
              <button
                key={f}
                className={'seg-btn' + (settings.fontFamily === f ? ' active' : '')}
                onClick={() => onChange({ fontFamily: f })}
              >
                {FONT_LABELS[f]}
              </button>
            ))}
          </div>
        </div>

        {settings.theme === 'night' && (
          <div className="sheet-row">
            <span className="sheet-label">亮度</span>
            <Stepper
              value={`${settings.brightness}`}
              onDec={() =>
                onChange({ brightness: Math.max(50, settings.brightness - 4) })
              }
              onInc={() =>
                onChange({ brightness: Math.min(100, settings.brightness + 4) })
              }
            />
          </div>
        )}

        <div className="sheet-row">
          <span className="sheet-label">字号</span>
          <Stepper
            value={`${settings.fontScale}%`}
            dec="A−"
            inc="A+"
            onDec={() =>
              onChange({ fontScale: Math.max(70, settings.fontScale - 10) })
            }
            onInc={() =>
              onChange({ fontScale: Math.min(240, settings.fontScale + 10) })
            }
          />
        </div>

        <div className="sheet-row">
          <span className="sheet-label">行距</span>
          <Stepper
            value={settings.lineHeight.toFixed(1)}
            onDec={() =>
              onChange({
                lineHeight: Math.max(1.2, +(settings.lineHeight - 0.1).toFixed(1)),
              })
            }
            onInc={() =>
              onChange({
                lineHeight: Math.min(2.6, +(settings.lineHeight + 0.1).toFixed(1)),
              })
            }
          />
        </div>

        <div className="sheet-row">
          <span className="sheet-label">字间距</span>
          <Stepper
            value={`${Math.round(settings.letterSpacing * 100)}%`}
            onDec={() =>
              onChange({
                letterSpacing: Math.max(0, +(settings.letterSpacing - 0.01).toFixed(2)),
              })
            }
            onInc={() =>
              onChange({
                letterSpacing: Math.min(0.2, +(settings.letterSpacing + 0.01).toFixed(2)),
              })
            }
          />
        </div>

        <div className="sheet-row">
          <span className="sheet-label">页边距</span>
          <Stepper
            value={`${settings.margin}%`}
            onDec={() => onChange({ margin: Math.max(0, settings.margin - 2) })}
            onInc={() => onChange({ margin: Math.min(20, settings.margin + 2) })}
          />
        </div>

        <div className="sheet-row">
          <span className="sheet-label">加粗</span>
          <button
            className={'toggle' + (settings.bold ? ' on' : '')}
            onClick={() => onChange({ bold: !settings.bold })}
            aria-pressed={settings.bold}
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <div className="sheet-row">
          <span className="sheet-label">两端对齐</span>
          <button
            className={'toggle' + (settings.justify ? ' on' : '')}
            onClick={() => onChange({ justify: !settings.justify })}
            aria-pressed={settings.justify}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      </div>
    </>
  )
}
