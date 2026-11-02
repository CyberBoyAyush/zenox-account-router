import type { Plugin } from '@opencode/plugin/tui'
import { RouterRpc } from './rpc.js'

const TITLE = 'Zenox Account Router'

/** Terminal UI part: `/router-status` opens a dialog with live account usage from the server part. */
export const routerTui: Plugin.Definition = {
  id: 'zenox.account-router.tui',
  setup(context) {
    const show = async (): Promise<void> => {
      context.ui.toast.show({ title: TITLE, message: 'Checking accounts…', variant: 'info', duration: 1500 })
      let text: string
      try {
        const location = context.location ?? context.data.location.default()
        const result = await context.client.rpc(RouterRpc).status({ refresh: true }, { location })
        text = typeof result === 'object' && result !== null && 'text' in result && typeof result.text === 'string'
          ? result.text
          : 'The router returned an unexpected response.'
      } catch {
        text = 'The router is not running on this OpenCode server.\n\nCheck that "zenox-account-router" is in the plugins list of your global opencode.json, that OpenCode is 2.2.5 or newer, and that setup has been run (npx zenox-account-router setup).'
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
        description: 'Show subscription usage, the active account and cooldowns',
        group: 'Zenox',
        palette: true,
        slash: { name: 'router-status', aliases: ['router'] },
        run: show,
      }],
    }))
  },
}

export default routerTui
