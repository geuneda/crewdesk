import type { ChannelPort, InboundMessage, OutboundMessage } from '@crewdesk/core'

export type MemoryChannel = ChannelPort & {
  inject(message: InboundMessage): void
  outbox(): OutboundMessage[]
}

export const createMemoryChannel = (): MemoryChannel => {
  let inbox: InboundMessage[] = []
  let sent: OutboundMessage[] = []
  return {
    inject: (message) => {
      inbox = [...inbox, message]
    },
    outbox: () => sent,
    poll: async () => {
      const messages = inbox
      inbox = []
      return messages
    },
    send: async (message) => {
      sent = [...sent, message]
    },
  }
}
