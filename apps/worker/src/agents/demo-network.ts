import type { NetworkId, WorkManifest } from "@terminus/domain"
import type { LayLineRequest } from "@terminus/protocol"
import { layLine, type DispatcherPorts } from "./dispatcher"

/**
 * Lays two Lines for the demo app until the Dispatcher can plan from a goal.
 * The Lines implement independent components from the same project baseline.
 */
export async function layDemoLines(
  ports: DispatcherPorts,
  networkId: NetworkId
): Promise<void> {
  await layLine(ports, networkId, redLine)
  await layLine(ports, networkId, blueLine)
}

const redLine: LayLineRequest = {
  name: "Red Line",
  stations: [
    {
      key: "footer",
      name: "Site footer",
      manifest: manifest({
        goal: "Add and export an accessible standalone Footer component with copyright and links. Do not wire it into App yet.",
        scope: ["A standalone Footer React component"],
        expectedAreas: ["src/components/footer.tsx"],
        contracts: [{ name: "Footer", kind: "symbol", change: "adds" }],
      }),
    },
    {
      key: "footer-tests",
      name: "Footer tests",
      manifest: manifest({
        goal: "Cover the footer with component tests",
        repositoryChange: {
          kind: "tests",
          description: "Add footer component tests",
        },
        expectedAreas: ["src/components/footer.test.tsx"],
        contracts: [{ name: "Footer", kind: "symbol", change: "depends_on" }],
        dependencies: ["footer"],
      }),
    },
  ],
}

const blueLine: LayLineRequest = {
  unloadMode: "human_approval",
  name: "Blue Line",
  stations: [
    {
      key: "theme-toggle",
      name: "Theme toggle",
      manifest: manifest({
        goal: "Add and export a standalone accessible light/dark ThemeToggle component using the existing ThemeProvider. Add tests. Do not edit App or Footer.",
        scope: ["ThemeToggle component and tests"],
        expectedAreas: [
          "src/components/theme-toggle.tsx",
          "src/components/theme-toggle.test.tsx",
        ],
        avoidAreas: [
          "package.json",
          "src/App.tsx",
          "src/components/footer.tsx",
        ],
        contracts: [{ name: "ThemeToggle", kind: "symbol", change: "adds" }],
      }),
    },
  ],
}

function manifest(
  fields: Pick<WorkManifest, "goal" | "expectedAreas"> & Partial<WorkManifest>
): WorkManifest {
  return {
    repositoryChange: { kind: "implementation", description: fields.goal },
    scope: [],
    avoidAreas: ["package.json"],
    contracts: [],
    invariants: ["Existing pages still render"],
    dependencies: [],
    acceptanceCriteria: ["Typecheck and tests pass"],
    expectedEvidence: ["typecheck", "test"],
    ...fields,
  }
}

/** Explicit Crossing demo: Footer checkpoint, independent theme work, then shared App wiring. */
export async function layCrossingDemoLines(
  ports: DispatcherPorts,
  networkId: NetworkId
): Promise<void> {
  const source = await layLine(ports, networkId, {
    ...redLine,
    name: "Footer Line",
    stations: [
      ...redLine.stations,
      {
        key: "footer-style",
        name: "Footer styling",
        manifest: manifest({
          goal: "Add a standalone footer stylesheet without changing the exported Footer contract or App.",
          expectedAreas: ["src/components/footer.css"],
        }),
      },
    ],
  })
  await layLine(ports, networkId, {
    ...blueLine,
    unloadMode: "auto",
    name: "Application Line",
    stations: [
      ...blueLine.stations,
      {
        key: "app-wiring",
        name: "App integration",
        manifest: manifest({
          goal: "Wire the accepted Footer and local ThemeToggle into App. Add focused App tests. The Footer implementation and tests arrive through the Crossing.",
          scope: ["App integration using the inherited Footer"],
          expectedAreas: ["src/App.tsx", "src/App.test.tsx"],
          contracts: [
            { name: "Footer", kind: "symbol", change: "depends_on" },
            { name: "ThemeToggle", kind: "symbol", change: "depends_on" },
          ],
          dependencies: ["theme-toggle"],
        }),
      },
    ],
    route: [
      { kind: "station", key: "theme-toggle" },
      {
        kind: "crossing",
        source: { kind: "existing", stationId: source.stations[1]!.id },
      },
      { kind: "station", key: "app-wiring" },
    ],
  })
}
