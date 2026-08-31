'use client'

import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

interface Props {
  content: string
}

function normalizeLatexDelimiters(content: string) {
  return content
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part) => {
      if (part.startsWith('`')) return part

      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => `\n$$\n${expression.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression: string) => `$${expression.trim()}$`)
    })
    .join('')
}

const markdownComponents: Components = {
  a: ({ children, node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children, node: _node, ...props }) => (
    <div className="ai-markdown-table-wrap">
      <table {...props}>{children}</table>
    </div>
  ),
}

export default function AIMessageContent({ content }: Props) {
  return (
    <div className="ai-markdown min-w-0 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
        components={markdownComponents}
        skipHtml
      >
        {normalizeLatexDelimiters(content)}
      </ReactMarkdown>
    </div>
  )
}
