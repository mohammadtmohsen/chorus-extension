import type { ReactElement } from 'react'
import type { WebviewToHost } from '@chorus/collaboration-protocol'
import { isAgentId } from '@mohammadtmohsen/shared'
import type { PendingApproval } from '@chorus/transcript'
import type { Host } from './Conversation.js'
import { t } from './strings.js'

export function ApprovalCard({
  approval,
  host,
}: {
  readonly approval: PendingApproval
  readonly host: Host
}): ReactElement {
  const decide = (allow: boolean): void => {
    if (!isAgentId(approval.agentId)) return
    const message: WebviewToHost = {
      kind: 'decide',
      agentId: approval.agentId,
      approvalId: approval.approvalId,
      allow,
    }
    host.postMessage(message)
  }

  return (
    <section className="card card--approval">
      <header className="card__head">
        <span className="card__kind">{approval.kind}</span>
        <span className="card__agent">{t('askedBy', approval.agentId)}</span>
      </header>

      <p className="card__summary">{approval.summary}</p>

      {approval.detail === null ? null : <pre className="card__detail">{approval.detail}</pre>}

      <div className="card__actions">
        <button type="button" onClick={() => { decide(false) }}>
          {t('deny')}
        </button>
        <button type="button" className="card__primary" onClick={() => { decide(true) }}>
          {t('allow')}
        </button>
      </div>
    </section>
  )
}
