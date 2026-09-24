import { useEffect, useReducer, type ReactElement } from 'react'
import type { HostToWebview, StatusLine, WebviewToHost } from '@chorus/collaboration-protocol'
import { EMPTY_VIEW, reduceEvents } from '@chorus/transcript'
import type { TranscriptView } from '@chorus/transcript'
import { ApprovalCard } from './ApprovalCard.js'
import { Composer } from './Composer.js'
import { QuestionCard } from './QuestionCard.js'
import { Transcript } from './Transcript.js'

export interface Host {
  postMessage(message: WebviewToHost): void
}

export interface State {
  readonly view: TranscriptView
  readonly status: StatusLine | null
  readonly draft: string
}

export const INITIAL: State = { view: EMPTY_VIEW, status: null, draft: '' }

/**
 * The host never sends a reduced view, only events.
 *
 * One reducer, in one place: the same `reduceEvents` the engine's own tests
 * drive. A host that sent a view would be a second implementation of it, and
 * the two would disagree exactly where a rendering bug is hardest to see.
 */
export function reduce(state: State, action: HostToWebview): State {
  switch (action.kind) {
    case 'events':
      return {
        view: reduceEvents(state.view, action.events),
        status: state.status,
        draft: state.draft,
      }
    case 'status':
      return { view: state.view, status: action.status, draft: state.draft }
    case 'draft':
      return { view: state.view, status: state.status, draft: action.text }
  }
}

export function Conversation({ host }: { readonly host: Host }): ReactElement {
  const [state, dispatch] = useReducer(reduce, INITIAL)

  useEffect(() => {
    const listener = (event: MessageEvent<HostToWebview>): void => {
      dispatch(event.data)
    }
    window.addEventListener('message', listener)
    host.postMessage({ kind: 'ready' })
    return () => {
      window.removeEventListener('message', listener)
    }
  }, [host])

  return (
    <div className="conversation">
      <Transcript messages={state.view.messages} working={state.view.working} />

      {state.view.questions.map((question) => (
        <QuestionCard key={question.userInputId} question={question} host={host} />
      ))}

      {state.view.approvals.map((approval) => (
        <ApprovalCard key={approval.approvalId} approval={approval} host={host} />
      ))}

      {state.status === null ? null : (
        <p className={`status status--${state.status.tone}`}>{state.status.text}</p>
      )}

      <Composer
        busy={state.view.busy}
        host={host}
        draft={state.draft}
        onDraft={(text) => {
          host.postMessage({ kind: 'draft', text })
        }}
      />
    </div>
  )
}
