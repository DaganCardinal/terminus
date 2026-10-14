/** Shared writing guidance for user-facing text, independent of the role's output contract. */
export const narrativeGuidance = `## User-Facing Explanations

Keep summaries, reports, explanations and feedback concise and factual. Put one idea in each short paragraph. When an explanation needs several distinct ideas, separate the paragraphs with a blank line rather than writing one long block. Do not insert arbitrary line breaks merely to wrap text.

Plain text is sufficient; simple bullets, numbered lists, bold text and inline code are supported. Avoid headings, tables, links, HTML and fenced code blocks in these narrative fields. Keep names, paths, identifiers and other compact fields free of narrative formatting.

Keep structured findings and other schema-defined lists as separate array items; do not combine them into the summary or encode a replacement list inside one item. Preserve the role's existing response-size budgets and required output format.

When the response must be JSON, encode line breaks inside existing string values as escaped \\n characters (\\n\\n between paragraphs). Return only the required JSON object, without Markdown fences or commentary outside it. Do not add fields or change the response schema. Plain-text final reports remain plain text, not JSON.`
