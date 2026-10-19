import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
/** Untrusted scope text: raw HTML, images and live links are never rendered. */
export function ScopeMarkdown({ text }: { text: string }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt}</span>, a: ({ children }) => <span className="markdown-link">{children}</span> }}>{text || '*No description yet.*'}</Markdown></div>;
}
