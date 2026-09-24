import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { WebviewToHost } from '@chorus/collaboration-protocol'
import { Conversation } from './Conversation.js'

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void }

const host = acquireVsCodeApi()

const container = document.getElementById('root')
if (container === null) throw new Error('the webview has no root element')

createRoot(container).render(
  <StrictMode>
    <Conversation host={host} />
  </StrictMode>
)
