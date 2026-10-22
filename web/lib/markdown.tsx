import Markdown, { type Components } from "react-markdown";

// External links open in a new tab; a link without an href renders as plain text.
export function SafeLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  return href ? <a href={href} target="_blank" rel="noreferrer noopener" className="underline">{children}</a> : <span>{children}</span>;
}

// react-markdown without raw HTML (its default) and without images. `components` overrides the defaults.
export function SafeMarkdown({ children, components }: { children: string; components?: Components }) {
  return (
    <Markdown disallowedElements={["img"]} components={{ a: SafeLink, ...components }}>
      {children}
    </Markdown>
  );
}
