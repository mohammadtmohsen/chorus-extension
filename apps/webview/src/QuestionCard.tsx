import { useState, type ReactElement } from 'react'
import type { WebviewToHost } from '@chorus/collaboration-protocol'
import { isAgentId } from '@chorus/shared'
import type { PendingQuestion } from '@chorus/transcript'
import type { Host } from './Conversation.js'
import { t } from './strings.js'

export function QuestionCard({
  question,
  host,
}: {
  readonly question: PendingQuestion
  readonly host: Host
}): ReactElement {
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({})

  const answer = (): void => {
    if (!isAgentId(question.agentId)) return
    const answers = question.questions
      .map((field) => ({ questionId: field.id, values: [chosen[field.id] ?? ''] }))
      .filter((entry) => entry.values[0] !== '')
    if (answers.length !== question.questions.length) return

    const message: WebviewToHost = {
      kind: 'answer',
      agentId: question.agentId,
      userInputId: question.userInputId,
      answers,
    }
    host.postMessage(message)
  }

  return (
    <section className="card card--question">
      <header className="card__head">
        <span className="card__kind">{t('askedBy', question.agentId)}</span>
      </header>

      {question.questions.map((field) => (
        <div key={field.id} className="card__question">
          <p className="card__summary">{field.question}</p>
          {field.options.map((option) => (
            <label key={option.label} className="card__option">
              <input
                type="radio"
                name={field.id}
                value={option.label}
                checked={chosen[field.id] === option.label}
                onChange={() => {
                  setChosen((previous) => ({ ...previous, [field.id]: option.label }))
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      ))}

      <div className="card__actions">
        <button
          type="button"
          className="card__primary"
          disabled={question.questions.some((field) => chosen[field.id] === undefined)}
          onClick={answer}
        >
          {t('answer')}
        </button>
      </div>
    </section>
  )
}
