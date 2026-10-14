import { Fragment, type ComponentProps, type ReactNode } from "react"
import { cn } from "../lib/utils"

export type ProseProps = Omit<ComponentProps<"div">, "children"> & {
  text: string
  /** Plain mode preserves paragraphs and breaks without interpreting markup. */
  format?: "light" | "plain"
}

type Item = { lines: string[]; number?: number }
type Block =
  | { kind: "paragraph"; lines: string[]; literal?: boolean }
  | { kind: "bullets" | "numbered"; items: Item[] }

function blocksFor(text: string, format: ProseProps["format"]): Block[] {
  const blocks: Block[] = []
  let current: Block | undefined
  let fence: { marker: string; length: number } | undefined
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    // Unsupported fenced blocks remain literal, including their markers.
    if (format === "light") {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
      if (fence) {
        if (current?.kind === "paragraph") current.lines.push(line)
        if (
          marker?.[0] === fence.marker &&
          marker.length >= fence.length &&
          line.trim() === marker
        ) {
          fence = undefined
          current = undefined
        }
        continue
      }
      if (marker) {
        fence = { marker: marker[0]!, length: marker.length }
        current = { kind: "paragraph", lines: [line], literal: true }
        blocks.push(current)
        continue
      }
    }
    if (!line.trim()) {
      current = undefined
      continue
    }
    const match =
      format === "light" ? /^\s*(?:([-*•])|(\d+)[.)])\s+(.+)$/.exec(line) : null
    if (match) {
      const kind = match[2] ? "numbered" : "bullets"
      if (current?.kind !== kind) {
        current = { kind, items: [] }
        blocks.push(current)
      }
      current.items.push({
        lines: [match[3]!],
        ...(match[2] ? { number: Number(match[2]) } : {}),
      })
    } else if (current && current.kind !== "paragraph" && /^\s+/.test(line)) {
      // An indented continuation belongs to the preceding list item.
      current.items.at(-1)!.lines.push(line.trimStart())
    } else {
      if (current?.kind !== "paragraph") {
        current = { kind: "paragraph", lines: [] }
        blocks.push(current)
      }
      current.lines.push(line)
    }
  }
  return blocks
}

function inline(text: string, formatted: boolean): ReactNode {
  if (!formatted) return text
  return text
    .split(/((?<!`)`[^`\n]+`(?!`)|\*\*[^*\n]+\*\*)/)
    .map((part, i) =>
      /^`[^`\n]+`$/.test(part) ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : /^\*\*[^*\n]+\*\*$/.test(part) ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      )
    )
}

function linesOf(lines: string[], formatted: boolean) {
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {inline(line, formatted)}
    </Fragment>
  ))
}

/** Paragraph-aware narrative text; full Markdown and raw HTML are not interpreted. */
export function Prose({
  text,
  format = "light",
  className,
  ...props
}: ProseProps) {
  const blocks = blocksFor(text, format)
  if (!blocks.length) return null
  return (
    <div {...props} className={cn("prose", className)}>
      {blocks.map((block, i) => {
        if (block.kind === "paragraph")
          return (
            <p key={i}>
              {linesOf(block.lines, format === "light" && !block.literal)}
            </p>
          )
        const List = block.kind === "numbered" ? "ol" : "ul"
        return (
          <List
            key={i}
            start={
              block.kind === "numbered" ? block.items[0]?.number : undefined
            }
          >
            {block.items.map((item, j) => (
              <li key={j} value={item.number}>
                {linesOf(item.lines, true)}
              </li>
            ))}
          </List>
        )
      })}
    </div>
  )
}
