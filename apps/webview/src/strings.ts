const EN = {
  composerPlaceholder: 'Write a message. Mention an agent to address it — @claude, @codex.',
  send: 'Send',
  stop: 'Stop',
  empty: 'Nothing has been said yet.',
  working: 'working',
  detail: 'detail',
  detailTruncated: 'detail (truncated)',
  summary: 'summary',
  handedTo: 'handed to {0}',
  allow: 'Allow',
  deny: 'Deny',
  answer: 'Answer',
  askedBy: '{0} is asking',
  cannotRun: 'The conversation could not be reached.',
} as const

export type StringKey = keyof typeof EN

export function t(key: StringKey, ...args: readonly (string | number)[]): string {
  let text: string = EN[key]
  args.forEach((arg, index) => {
    text = text.replace(`{${String(index)}}`, String(arg))
  })
  return text
}
