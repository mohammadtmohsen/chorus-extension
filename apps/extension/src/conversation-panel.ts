import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import {
  WebviewToHostSchema,
  type HostToWebview,
  type StatusLine,
  type WebviewToHost,
  type WireStoredEvent,
} from '@chorus/collaboration-protocol'

export interface PanelHandlers {
  readonly onReady: () => void
  readonly onSend: (message: Extract<WebviewToHost, { kind: 'send' }>) => void
  readonly onDraft: (message: Extract<WebviewToHost, { kind: 'draft' }>) => void
  readonly onStop: () => void
  readonly onDecide: (message: Extract<WebviewToHost, { kind: 'decide' }>) => void
  readonly onAnswer: (message: Extract<WebviewToHost, { kind: 'answer' }>) => void
}

export interface ConversationPanel {
  title(title: string): void
  status(status: StatusLine): void
  events(events: readonly WireStoredEvent[]): void
  draft(text: string): void
  reveal(): void
  dispose(): void
}

const VIEW_TYPE = 'chorusCollaboration.conversation'

export function createConversationPanel(
  context: vscode.ExtensionContext,
  title: string,
  handlers: PanelHandlers
): ConversationPanel {
  const root = vscode.Uri.joinPath(context.extensionUri, 'webview')

  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [root],
  })

  const nonce = randomBytes(16).toString('base64')
  panel.webview.html = renderHtml(panel.webview, root, nonce)

  let disposed = false

  const post = (message: HostToWebview): void => {
    if (disposed) return
    void panel.webview.postMessage(message)
  }

  const subscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
    const parsed = WebviewToHostSchema.safeParse(raw)
    if (!parsed.success) return

    switch (parsed.data.kind) {
      case 'ready':
        handlers.onReady()
        return
      case 'send':
        handlers.onSend(parsed.data)
        return
      case 'draft':
        handlers.onDraft(parsed.data)
        return
      case 'stop':
        handlers.onStop()
        return
      case 'decide':
        handlers.onDecide(parsed.data)
        return
      case 'answer':
        handlers.onAnswer(parsed.data)
        return
    }
  })

  panel.onDidDispose(() => {
    disposed = true
    subscription.dispose()
  })

  return {
    title(next) {
      if (!disposed) panel.title = next
    },
    status(status) {
      post({ kind: 'status', status })
    },
    events(events) {
      if (events.length > 0) post({ kind: 'events', events })
    },
    draft(text) {
      post({ kind: 'draft', text })
    },
    reveal() {
      if (!disposed) panel.reveal()
    },
    dispose() {
      if (disposed) return
      disposed = true
      subscription.dispose()
      panel.dispose()
    },
  }
}

function renderHtml(webview: vscode.Webview, root: vscode.Uri, nonce: string): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview.js'))
  const styles = webview.asWebviewUri(vscode.Uri.joinPath(root, 'styles.css'))

  const policy = [
    `default-src 'none'`,
    `img-src ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${policy}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styles.toString()}" />
    <title>Chorus Collaboration</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script.toString()}"></script>
  </body>
</html>`
}
