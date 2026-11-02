import type { Rpc } from '@opencode/plugin/rpc'

/**
 * Typed RPC contract between the server plugin and its terminal UI part (and any other client).
 * A plain object: `Rpc.define` only validates reserved error names, so no SDK is needed at runtime.
 */
export const RouterRpc = {
  id: 'zenox-account-router',
  methods: {
    status: {
      input: {
        type: 'object',
        properties: { refresh: { type: 'boolean' } },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          report: { type: 'object' },
        },
        required: ['text', 'report'],
      },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export default RouterRpc
