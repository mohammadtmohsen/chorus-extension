import { createElement, type ReactElement, type ReactNode } from 'react'
import {
  isSafeHref,
  parseMarkdown,
  type Block,
  type Inline,
  type ListItem,
  type Row,
} from '@chorus/transcript'

/**
 * Draws the parser's own tree, never a string of HTML.
 *
 * Agent output is untrusted, and this is the only place in the interface where
 * it becomes markup. Building from a typed tree makes injection impossible by
 * construction — there is no `dangerouslySetInnerHTML` anywhere in this app,
 * and a link is only a link when `isSafeHref` says the scheme is one.
 */
export function Markdown({ source }: { readonly source: string }): ReactElement {
  return <>{blocks(parseMarkdown(source), 'b')}</>
}

function blocks(list: readonly Block[], keyBase: string): ReactNode[] {
  return list.map((block, index) => blockNode(block, `${keyBase}-${String(index)}`))
}

function blockNode(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return <p key={key}>{inlines(block.content, key)}</p>
    case 'heading':
      return createElement(`h${String(block.level)}`, { key }, inlines(block.content, key))
    case 'code':
      return (
        <pre key={key} className="md-code">
          <code>{block.text}</code>
        </pre>
      )
    case 'list':
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {items(block.items, key)}
        </ol>
      ) : (
        <ul key={key}>{items(block.items, key)}</ul>
      )
    case 'quote':
      return <blockquote key={key}>{blocks(block.blocks, key)}</blockquote>
    case 'table':
      return (
        <table key={key}>
          <thead>
            <tr>{cells(block.head, `${key}-h`, 'th')}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, index) => (
              <tr key={`${key}-r${String(index)}`}>
                {cells(row, `${key}-r${String(index)}`, 'td')}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'rule':
      return <hr key={key} />
  }
}

function items(list: readonly ListItem[], keyBase: string): ReactNode[] {
  return list.map((item, index) => {
    const key = `${keyBase}-i${String(index)}`
    return (
      <li key={key} className={item.checked === null ? undefined : 'md-task'}>
        {item.checked === null ? null : (
          <input type="checkbox" checked={item.checked} readOnly disabled />
        )}
        {inlines(item.content, key)}
        {item.children.length === 0 ? null : blocks(item.children, key)}
      </li>
    )
  })
}

function cells(row: Row, keyBase: string, tag: 'th' | 'td'): ReactNode[] {
  return row.map((cell, index) => createElement(tag, { key: `${keyBase}-${String(index)}` }, inlines(cell, `${keyBase}-${String(index)}`)))
}

function inlines(list: readonly Inline[], keyBase: string): ReactNode[] {
  return list.map((inline, index) => {
    const key = `${keyBase}-${String(index)}`
    switch (inline.kind) {
      case 'text':
        return inline.text
      case 'code':
        return <code key={key}>{inline.text}</code>
      case 'strong':
        return <strong key={key}>{inlines(inline.content, key)}</strong>
      case 'em':
        return <em key={key}>{inlines(inline.content, key)}</em>
      case 'del':
        return <del key={key}>{inlines(inline.content, key)}</del>
      case 'link':
        return isSafeHref(inline.href) ? (
          <a key={key} href={inline.href}>
            {inlines(inline.content, key)}
          </a>
        ) : (
          <span key={key}>{inlines(inline.content, key)}</span>
        )
      case 'image':
        return isSafeHref(inline.href) ? (
          <img key={key} src={inline.href} alt={inline.alt} className="md-image" />
        ) : (
          <span key={key}>{inline.alt}</span>
        )
    }
  })
}
