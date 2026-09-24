import type { Database } from './port.js'

export type LedgerState = 'pending' | 'settled'

export interface LedgerEntry {
  readonly requestId: string
  readonly conversationId: string | null
  readonly state: LedgerState
  readonly result: unknown
}

interface Row {
  readonly request_id: string
  readonly conversation_id: string | null
  readonly state: string
  readonly result: string | null
}

function toEntry(row: Row): LedgerEntry {
  return {
    requestId: row.request_id,
    conversationId: row.conversation_id,
    state: row.state === 'settled' ? 'settled' : 'pending',
    result: row.result === null ? null : (JSON.parse(row.result) as unknown),
  }
}

export class CommandLedger {
  constructor(private readonly db: Database) {}

  recall(requestId: string): LedgerEntry | null {
    const row = this.db
      .prepare(
        `SELECT request_id, conversation_id, state, result
           FROM command_ledger
          WHERE request_id = @requestId`
      )
      .get({ requestId })
    return row === undefined ? null : toEntry(row as Row)
  }

  claim(requestId: string, conversationId: string | null, now: number = Date.now()): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO command_ledger
           (request_id, conversation_id, state, result, created_at)
         VALUES (@requestId, @conversationId, 'pending', NULL, @createdAt)`
      )
      .run({ requestId, conversationId, createdAt: now })
    return info.changes === 1
  }

  settle(requestId: string, conversationId: string | null, result: unknown): void {
    this.db
      .prepare(
        `UPDATE command_ledger
            SET state = 'settled',
                conversation_id = @conversationId,
                result = @result
          WHERE request_id = @requestId`
      )
      .run({ requestId, conversationId, result: JSON.stringify(result) })
  }
}
