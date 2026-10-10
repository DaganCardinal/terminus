import { describe, expect, it } from "vitest"
import { splitScope } from "./detail-parts"

describe("splitScope", () => {
  it("splits a leading file path from its description", () => {
    expect(
      splitScope("src/features/support/route.ts: parse a tag query parameter")
    ).toEqual({
      path: "src/features/support/route.ts",
      text: "parse a tag query parameter",
    })
    expect(
      splitScope("`src/App.tsx` - pass route.tag into TicketsPage")
    ).toEqual({ path: "src/App.tsx", text: "pass route.tag into TicketsPage" })
  })

  it("leaves prose scope lines whole", () => {
    expect(splitScope("Tests for tag counting: open and pending only")).toEqual(
      {
        text: "Tests for tag counting: open and pending only",
      }
    )
  })
})
