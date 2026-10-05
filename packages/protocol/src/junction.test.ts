import { it, expect } from "vitest"
import { integrationInputSchema } from "./integration"
import {
  lineOriginSchema,
  lineDestinationSchema,
  junctionRepairRequestSchema,
} from "./junction"
const input = {
  id: "i",
  networkId: "n",
  trainId: "t",
  trainRepoId: "tr",
  trainCommit: "source",
  trainBaseline: "base",
  terminusRepoId: "target",
  terminusCommit: "target-head",
  acceptedCommits: ["source"],
  validation: [{ name: "test", command: ["npm", "test"] }],
}
it("normalizes destination-aware integration references and rejects inconsistent boundaries", () => {
  expect(integrationInputSchema.parse(input).target).toMatchObject({
    kind: "terminus",
    networkId: "n",
    repoId: "target",
    commit: "target-head",
  })
  expect(
    integrationInputSchema.parse({
      ...input,
      purpose: "junction",
      junctionId: "j",
    })
  ).toMatchObject({
    source: { kind: "train", trainId: "t" },
    target: { kind: "junction", junctionId: "j" },
  })
  expect(
    integrationInputSchema.parse({
      ...input,
      purpose: "crossing",
      crossingId: "x",
    })
  ).toMatchObject({
    source: { kind: "checkpoint", crossingId: "x" },
    target: { kind: "train", trainId: "t" },
  })
  expect(
    integrationInputSchema.safeParse({ ...input, purpose: "junction" }).success
  ).toBe(false)
  expect(
    integrationInputSchema.safeParse({
      ...input,
      purpose: "junction",
      junctionId: "j",
      target: {
        kind: "terminus",
        networkId: "n",
        repoId: "target",
        commit: "target-head",
      },
    }).success
  ).toBe(false)
  expect(
    lineOriginSchema.safeParse({ kind: "junction", junctionId: "" }).success
  ).toBe(false)
  expect(lineDestinationSchema.parse({ kind: "terminus" })).toEqual({
    kind: "terminus",
  })
  expect(
    junctionRepairRequestSchema.safeParse({ failureId: "f", scope: [] }).success
  ).toBe(false)
})
