import { useEffect, useState, type ReactElement } from 'react'
import type { Host } from './Conversation.js'
import { t } from './strings.js'

export function Composer({
  busy,
  host,
  draft,
  onDraft,
}: {
  readonly busy: boolean
  readonly host: Host
  readonly draft: string
  readonly onDraft: (text: string) => void
}): ReactElement {
  const [text, setText] = useState(draft)

  useEffect(() => {
    setText(draft)
  }, [draft])

  const send = (): void => {
    const trimmed = text.trim()
    if (trimmed === '' || busy) return
    host.postMessage({ kind: 'send', text: trimmed })
    setText('')
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <textarea
        className="composer__input"
        aria-label={t('composerPlaceholder')}
        placeholder={t('composerPlaceholder')}
        rows={3}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          onDraft(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        }}
      />

      <div className="composer__actions">
        <button
          type="button"
          className="composer__stop"
          disabled={!busy}
          onClick={() => {
            host.postMessage({ kind: 'stop' })
          }}
        >
          {t('stop')}
        </button>
        <button type="submit" className="composer__send" disabled={busy || text.trim() === ''}>
          {t('send')}
        </button>
      </div>
    </form>
  )
}
