/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import { For } from 'solid-js'
import { layoutReport } from './report.js'
import type { Line, StatusReport, Tone } from './report.js'

type Context = Parameters<Plugin.Definition['setup']>[0]
type Color = Context['theme']['text']['base']

function palette(context: Context): Record<Tone, Color> {
  const theme = context.theme.surface('dialog')
  return {
    text: theme.text.base,
    strong: theme.text.base,
    muted: theme.text.muted,
    faint: theme.text.faint,
    accent: theme.text.feedback.info.base,
    good: theme.text.feedback.success.base,
    warn: theme.text.feedback.warning.base,
    bad: theme.text.feedback.error.base,
  }
}

function ReportLine(props: { line: Line; colors: Record<Tone, Color> }) {
  return (
    <text wrapMode="none" selectable={false} flexShrink={0}>
      {props.line.length ? null : ' '}
      <For each={props.line}>
        {segment => <span style={{ fg: props.colors[segment.tone ?? 'text'], bold: segment.tone === 'strong' || segment.tone === 'accent' }}>{segment.text}</span>}
      </For>
    </text>
  )
}

/** Opens the themed status dialog. Escape closes it (handled by OpenCode's dialog host). */
export function showStatusDialog(context: Context, report: StatusReport): void {
  const colors = palette(context)
  const lines = layoutReport(report)
  context.ui.dialog.show(() => (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text selectable={false}>
          <span style={{ fg: colors.text, bold: true }}>Zenox Account Router</span>
          <span style={{ fg: colors.muted }}>{report.live ? '  ·  live' : ''}</span>
        </text>
        <text fg={colors.muted} selectable={false}>esc</text>
      </box>
      <For each={lines}>{line => <ReportLine line={line} colors={colors} />}</For>
    </box>
  ))
  context.ui.dialog.set({ size: 'large' })
}
