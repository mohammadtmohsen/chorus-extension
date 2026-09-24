import type { ReactElement } from 'react'
import type { TranscriptEvent, TranscriptMessage } from '@chorus/transcript'
import { Message } from './Message.js'
import { t } from './strings.js'

export function Transcript({
  messages,
  working,
}: {
  readonly messages: readonly TranscriptMessage[]
  readonly working: readonly TranscriptEvent['actor'][]
}): ReactElement {
  if (messages.length === 0) {
    return <p className="empty">{t('empty')}</p>
  }

  return (
    <div className="transcript">
      {messages.map((message) => (
        <Message key={message.key} message={message} working={working.includes(message.actor)} />
      ))}
    </div>
  )
}
