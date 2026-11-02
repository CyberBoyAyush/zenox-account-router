import type { Plugin } from '@opencode/plugin/tui'
import type { StatusReport } from './report.js'
import { RouterRpc } from './rpc.js'

const TITLE = 'Zenox Account Router'
const NOT_RUNNING = 'The router is not running on this OpenCode server.\n\nCheck that "zenox-account-router" is in the plugins list of your global opencode.json, that OpenCode is 2.2.5 or newer, and that setup has been run (npx zenox-account-router setup).'

type Context = Parameters<Plugin.Definition['setup']>[0]
type DialogView = { showStatusDialog: (context: Context, report: StatusReport) => void }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Validates everything the dialog reads, so a mismatched server version falls back instead of failing mid-render. */
export function isReport(value: unknown): value is StatusReport {
  if (!record(value) || typeof value.generatedAt !== 'number' || typeof value.pollIntervalMs !== 'number' || typeof value.live !== 'boolean' || typeof value.liveAccounts !== 'boolean' || !Array.isArray(value.providers)) return false
  return value.providers.every(provider => record(provider) && (provider.provider === 'anthropic' || provider.provider === 'openai') && typeof provider.paidFallback === 'boolean'
    && (provider.next === null || (record(provider.next) && typeof provider.next.label === 'string'))
    && Array.isArray(provider.accounts) && provider.accounts.every(account => record(account) && typeof account.label === 'string' && (account.method === 'oauth' || account.method === 'key')
      && (account.usage === undefined || (record(account.usage) && typeof account.usage.status === 'string' && typeof account.usage.checkedAt === 'number' && Array.isArray(account.usage.windows)
        && account.usage.windows.every(window => record(window) && typeof window.label === 'string' && (window.usedPercent === null || typeof window.usedPercent === 'number') && (window.resetsAt === null || typeof window.resetsAt === 'number'))))))
}

/**
 * Terminal UI part: `/router-status` opens a themed dialog with live account usage from the server part.
 * The coloured view is JSX rendered by OpenCode's OpenTUI; if it cannot load, the plain-text alert is used.
 */
export function createRouterTui(loadView: () => Promise<DialogView> = () => import('./tui-view.js')): Plugin.Definition {
  return {
    id: 'zenox.account-router.tui',
    setup(context) {
      const show = async (): Promise<void> => {
        context.ui.toast.show({ title: TITLE, message: 'Checking accounts…', variant: 'info', duration: 1500 })
        let text = NOT_RUNNING
        let report: StatusReport | undefined
        try {
          const location = context.location ?? context.data.location.default()
          const result: unknown = await context.client.rpc(RouterRpc).status({ refresh: true }, { location })
          if (typeof result === 'object' && result !== null && 'text' in result && typeof result.text === 'string') {
            text = result.text
            if ('report' in result && isReport(result.report)) report = result.report
          } else text = 'The router returned an unexpected response.'
        } catch { /* keep NOT_RUNNING */ }
        if (report) {
          try {
            const view = await loadView()
            view.showStatusDialog(context, report)
            return
          } catch { /* fall back to the plain dialog */ }
        }
        const dialog = context.ui.dialog.alert({ title: TITLE, message: text })
        context.ui.dialog.set({ size: 'large' })
        await dialog
      }
      context.keymap.layer(() => ({
        mode: 'global',
        commands: [{
          id: 'zenox.router.status',
          title: 'Router: account status',
          description: 'Show subscription usage, the active account and what happens next',
          group: 'Zenox',
          palette: true,
          slash: { name: 'router-status', aliases: ['router'] },
          run: show,
        }],
      }))
    },
  }
}

export const routerTui = createRouterTui()

export default routerTui
