import type { ReactElement } from 'react'
import type { TranscriptMessage } from '@chorus/transcript'
import { Markdown } from './Markdown.js'
import { t } from './strings.js'

function clockTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function Message({
  message,
  working,
}: {
  readonly message: TranscriptMessage
  readonly working: boolean
}): ReactElement {
  const streaming = message.status === 'streaming'

  return (
    <article className={`entry entry--${message.kind} entry--${message.actor}`}>
      <header className="entry__head">
        <span className="entry__actor">{message.actor}</span>
        <time className="entry__at">{clockTime(message.at)}</time>
        {working || streaming ? <span className="entry__live">{t('working')}</span> : null}
      </header>

      {message.handoffTo === undefined ? null : (
        <p className="entry__handoff">{t('handedTo', message.handoffTo)}</p>
      )}

      <div className="entry__body">
        <Markdown source={message.text} />
      </div>

      {message.detail === undefined ? null : (
        <details className="entry__detail">
          <summary>
            {message.detailOmittedBytes === undefined ? t('detail') : t('detailTruncated')}
          </summary>
          <pre>{message.detail}</pre>
        </details>
      )}

      {message.changes === undefined
        ? null
        : message.changes.map((file) => (
            <div key={file.path} className="entry__file">
              <span className={`entry__change entry__change--${file.change}`}>{file.change}</span>
              <span className="entry__path">{file.path}</span>
              <span className="entry__counts">
                +{file.added} −{file.removed}
              </span>
            </div>
          ))}
    </article>
  )
}
