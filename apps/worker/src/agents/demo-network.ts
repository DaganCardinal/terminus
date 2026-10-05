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

/** Two feature inputs converge independently of a main-Line delivery. */
export async function layJunctionDemo(
  ports: import("./junctions").JunctionDispatchPorts,
  networkId: NetworkId,
  conductorModel: string,
  options: { direct?: boolean; crossing?: boolean } = {}
) {
  const { layJunction } = await import("./junctions")
  const requestId = options.direct
    ? "00000000-0000-4000-8000-000000000002"
    : "00000000-0000-4000-8000-000000000001"
  const id = `${networkId}-junction-${requestId}`
  const already = await ports.store.junction(id)
  const junction = await layJunction(
    ports,
    networkId,
    {
      requestId,
      name: "Site components",
      brief: {
        goal: "Deliver accessible Footer and ThemeToggle components together",
        scope: ["src/components/"],
        contracts: [
          { name: "Footer", kind: "symbol", change: "adds" },
          { name: "ThemeToggle", kind: "symbol", change: "adds" },
        ],
        invariants: ["Existing pages and ThemeProvider still work"],
        acceptanceCriteria: [
          "Footer exports accessible copyright and navigation links",
          "ThemeToggle changes light/dark theme through ThemeProvider",
          "Both components pass their tests together",
        ],
        validation: [{ name: "feature-test", command: ["npm", "test"] }],
      },
      incoming: [
        { name: "Footer Line", stations: redLine.stations },
        {
          name: "Theme Line",
          stations: [
            ...blueLine.stations,
            ...(options.crossing
              ? [
                  {
                    key: "feature-tests",
                    name: "Component compatibility tests",
                    manifest: manifest({
                      goal: "Add focused compatibility tests that render the accepted Footer and ThemeToggle together using ThemeProvider. Do not edit the components or App.",
                      repositoryChange: {
                        kind: "tests",
                        description: "Add component compatibility tests",
                      },
                      scope: ["Tests for the combined standalone feature"],
                      expectedAreas: [
                        "src/components/feature-components.test.tsx",
                      ],
                      contracts: [
                        {
                          name: "Footer",
                          kind: "symbol",
                          change: "depends_on",
                        },
                        {
                          name: "ThemeToggle",
                          kind: "symbol",
                          change: "depends_on",
                        },
                      ],
                      dependencies: ["theme-toggle"],
                    }),
                  },
                ]
              : []),
          ],
          ...(options.crossing
            ? {
                route: [
                  { kind: "station" as const, key: "theme-toggle" },
                  {
                    kind: "crossing" as const,
                    source: {
                      kind: "planned" as const,
                      stationKey: "footer-tests",
                    },
                  },
                  { kind: "station" as const, key: "feature-tests" },
                ],
              }
            : {}),
        },
      ],
      outgoing: {
        name: "Feature delivery",
        unloadMode: "auto",
        stations: options.direct
          ? []
          : [
              {
                key: "app-wiring",
                name: "Wire components into App",
                manifest: manifest({
                  goal: "Wire the accepted Footer and ThemeToggle into App and add focused App tests. Both components already arrived through the Junction. Preserve their implementations.",
                  scope: ["App integration"],
                  expectedAreas: ["src/App.tsx", "src/App.test.tsx"],
                  contracts: [
                    { name: "Footer", kind: "symbol", change: "depends_on" },
                    {
                      name: "ThemeToggle",
                      kind: "symbol",
                      change: "depends_on",
                    },
                  ],
                }),
              },
            ],
      },
    },
    conductorModel
  )
  if (!already)
    await layLine(ports, networkId, {
      name: "Independent badge",
      stations: [
        {
          key: "badge",
          name: "Standalone badge",
          manifest: manifest({
            goal: "Add and export a standalone accessible Badge React component and tests. Do not wire it into App or edit Footer, ThemeToggle, or ThemeProvider.",
            scope: ["Badge component and tests"],
            expectedAreas: [
              "src/components/badge.tsx",
              "src/components/badge.test.tsx",
            ],
            contracts: [{ name: "Badge", kind: "symbol", change: "adds" }],
          }),
        },
      ],
    })
  return junction
}
