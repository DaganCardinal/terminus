import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { NetworkSnapshot } from "@terminus/protocol"
import { DispatcherPanel } from "./dispatcher"

function render(planning: boolean) {
  const snapshot = {
    network: { id: "network", name: "Demo" },
    lines: [],
    trains: [],
    stations: [],
    conflicts: [],
    repairs: [],
    plans: planning
      ? [
          {
            id: "dispatch-test",
            goal: "Add a footer",
            terminusCommit: "a".repeat(40),
            createdAt: new Date().toISOString(),
            state: { status: "planning" },
          },
        ]
      : [],
  } as unknown as NetworkSnapshot
  return renderToStaticMarkup(
    <DispatcherPanel
      snapshot={snapshot}
      open
      mobile={false}
      onClose={() => {}}
      onResize={() => {}}
      openTrain={() => {}}
    />
  )
}
describe("Dispatcher composer", () => {
  it("offers an enabled Stop after a refresh with planning in progress and an empty draft", () => {
    const html = render(true)
    expect(html).toMatch(
      /<button type="button" class="composer-send composer-stop" aria-label="Stop Dispatcher planning">Stop<\/button>/
    )
    expect(html).not.toContain('aria-label="Send goal to the Dispatcher"')
  })
  it("returns to Send while idle", () => {
    const html = render(false)
    expect(html).toContain('aria-label="Send goal to the Dispatcher"')
    expect(html).not.toContain('aria-label="Stop Dispatcher planning"')
  })
})
