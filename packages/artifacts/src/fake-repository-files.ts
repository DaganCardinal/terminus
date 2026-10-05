/**
 * The committed files of the fake Terminus repository, so offline networks
 * have a project to browse. Content is illustrative, not read from anywhere.
 */
export const fakeRepositoryFiles: Record<string, string> = {
  "README.md": `# Lantern

A small React dashboard for tracking field-station readings. Lantern is the
demo project Terminus manages when it runs offline.

## Getting started

\`\`\`bash
npm install
npm run dev
\`\`\`

The app runs at \`http://localhost:5173\`.

## Project layout

| Path | Holds |
| --- | --- |
| \`src/App.tsx\` | Application shell and routing |
| \`src/components/\` | Shared, presentation-only components |
| \`src/readings/\` | Reading list, filters and detail views |
| \`docs/\` | Architecture notes and contributor guides |

## Scripts

- \`npm run dev\` — start the Vite dev server
- \`npm run build\` — type-check and build for production
- \`npm test\` — run the Vitest suite

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.
`,
  "AGENTS.md": `# AGENTS.md

Guidance for coding agents working on Lantern.

## Ground rules

- Keep components presentation-only. Data fetching lives in \`src/readings/api.ts\`.
- Every new component gets a colocated test (\`Foo.tsx\` → \`Foo.test.tsx\`).
- Use the existing Tailwind tokens; don't introduce new colours inline.
- Run \`npm test\` and \`npm run build\` before declaring work complete.

## Areas to avoid

- \`src/theme/\` is owned by the design team. Propose changes instead of editing.
- Never commit \`.env\` files or API keys.
`,
  LICENSE: `MIT License

Copyright (c) 2026 Lantern contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  "CONTRIBUTING.md": `# Contributing

1. Fork and branch from \`main\`.
2. Keep changes focused; one concern per pull request.
3. Add or update tests alongside the change.
4. Describe *why* in the pull request, not just *what*.
`,
  "docs/architecture.md": `# Architecture

Lantern is a single-page React app built with Vite.

- **Shell** — \`src/App.tsx\` owns layout and top-level routes.
- **Readings** — \`src/readings/\` fetches readings, filters them client-side
  and renders the list and detail views.
- **Components** — \`src/components/\` holds shared UI with no data access.

Data flows one way: \`api.ts\` → hooks → views. Views never fetch directly.
`,
  "docs/testing.md": `# Testing

Tests use Vitest and Testing Library. Prefer queries by role and label over
test ids, and assert on what a person would see.
`,
  "package.json": `{
  "name": "lantern",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run"
  }
}
`,
  "index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Lantern</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
`,
  "src/main.tsx": `import { createRoot } from "react-dom/client"
import { App } from "./App"

createRoot(document.getElementById("root")!).render(<App />)
`,
  "src/App.tsx": `import { ReadingList } from "./readings/ReadingList"

export function App() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-lg font-semibold">Lantern</h1>
      <ReadingList />
    </main>
  )
}
`,
  "src/components/theme-provider.tsx": `export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
`,
  "src/readings/api.ts": `export interface Reading {
  id: string
  station: string
  value: number
  takenAt: string
}

export async function readings(): Promise<Reading[]> {
  const response = await fetch("/api/readings")
  return response.json()
}
`,
  "src/readings/ReadingList.tsx": `import { useEffect, useState } from "react"
import { readings, type Reading } from "./api"

export function ReadingList() {
  const [items, setItems] = useState<Reading[]>([])
  useEffect(() => void readings().then(setItems), [])
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.station}: {item.value}</li>
      ))}
    </ul>
  )
}
`,
  "src/readings/README.md": `# Readings

Everything about listing and inspecting readings. \`api.ts\` is the only
module here that talks to the network.
`,
  "tsconfig.json": `{
  "compilerOptions": { "strict": true, "jsx": "react-jsx", "module": "ESNext" }
}
`,
}
