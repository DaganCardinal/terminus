import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { Prose, type ProseProps } from "./prose"

const render = (text: string, props: Omit<ProseProps, "text"> = {}) =>
  renderToStaticMarkup(<Prose text={text} {...props} />)

describe("Prose", () => {
  it("preserves explicit breaks and separates paragraphs without empty blocks", () => {
    expect(render("\n\nFirst\nsecond\n \t\n\nThird\n\n")).toBe(
      '<div class="prose"><p>First<br/>second</p><p>Third</p></div>'
    )
    expect(render("First. Second. Third.")).toBe(
      '<div class="prose"><p>First. Second. Third.</p></div>'
    )
  })
  it("normalizes Windows and old Mac newlines", () => {
    expect(render("First\r\nsecond\r\n\r\nThird\rfourth")).toBe(
      render("First\nsecond\n\nThird\nfourth")
    )
  })
  it.each(["", "  \t\r\n\n"])("renders no empty wrapper for %j", (text) => {
    expect(render(text)).toBe("")
  })
  it("keeps paragraphs distinct from lists and supports indented continuations", () => {
    expect(render("Intro\n- First\n  continued\n• Second\nConclusion")).toBe(
      '<div class="prose"><p>Intro</p><ul><li>First<br/>continued</li><li>Second</li></ul><p>Conclusion</p></div>'
    )
  })
  it("preserves ordered-list numbering, including gaps and list boundaries", () => {
    expect(render("3. Three\n5) Five\n- Bullet\n\n1. New list")).toBe(
      '<div class="prose"><ol start="3"><li value="3">Three</li><li value="5">Five</li></ol><ul><li>Bullet</li></ul><ol start="1"><li value="1">New list</li></ol></div>'
    )
  })
  it("renders bold and inline code while keeping code contents literal", () => {
    expect(render("**Accepted** `**literal**`\n`src/app.ts`")).toBe(
      '<div class="prose"><p><strong>Accepted</strong> <code>**literal**</code><br/><code>src/app.ts</code></p></div>'
    )
  })
  it("preserves all markup literally in plain mode", () => {
    expect(render("**Title**\n- Item\n\n3. `Code`", { format: "plain" })).toBe(
      '<div class="prose"><p>**Title**<br/>- Item</p><p>3. `Code`</p></div>'
    )
  })
  it("keeps unsupported Markdown and HTML inert", () => {
    const text =
      '# Heading\n[Link](javascript:alert(1))\n<img src=x onerror="alert(1)">'
    const html = render(text)
    expect(html).toContain("# Heading<br/>[Link](javascript:alert(1))")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<a")
    expect(render("```ts\n- literal\n\n**literal**\n```\nAfter")).toBe(
      '<div class="prose"><p>```ts<br/>- literal<br/><br/>**literal**<br/>```</p><p>After</p></div>'
    )
  })
  it("forwards wrapper attributes and composes contextual styles", () => {
    expect(
      render("Review", {
        className: "callout-lead",
        role: "note",
        id: "review",
      })
    ).toBe(
      '<div role="note" id="review" class="prose callout-lead"><p>Review</p></div>'
    )
  })
})
