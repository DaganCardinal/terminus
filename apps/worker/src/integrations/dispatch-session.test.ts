import { describe, expect, it, vi } from "vitest"
import { env } from "cloudflare:test"
import type { RepositoryAccess } from "@terminus/artifacts"
import {
  HarnessDispatcher,
  PlanToolFormatStalled,
  ProposalSubmissionsExhausted,
} from "@terminus/agent-runtime"
import { seedDispatchPlan } from "../../test/fixtures"
import { DispatchDraftStore } from "./dispatch-draft-store"
import { SandboxDispatchSessions } from "./dispatch-session"
import type { StationSandbox } from "./station-runner"
import type {
  ActivityObserver,
  AgentActivity,
  PlanDraft,
  PlanStation,
} from "@terminus/protocol"

const model = "@cf/zai-org/glm-5.3"
const commit = "a".repeat(40)
const network = {
  projectChecks: [{ name: "test", command: ["npm", "test"] }],
  activeLines: [],
}
const savedStation = (key: string): PlanStation => ({
  key,
  name: `Station ${key}`,
  goal: `Deliver ${key}`,
  changeKind: "implementation",
  changeDescription: `Implement ${key}`,
  scope: [`Only ${key}`],
  expectedAreas: [`src/${key}.ts`],
  acceptanceCriteria: [`${key} works`],
  invariants: ["Existing behavior remains"],
  expectedEvidence: ["test"],
})
const partialDraft: PlanDraft = {
  outline: {
    summary: "Two Stations",
    lines: [
      {
        key: "feature",
        name: "Feature",
        unloadRecommendation: { mode: "auto", reason: "Bounded" },
        stations: ["a", "b"],
      },
    ],
  },
  stations: { a: savedStation("a") },
}
const completeDraft: PlanDraft = {
  ...partialDraft,
  stations: { ...partialDraft.stations, b: savedStation("b") },
}
const planningInput = (planId: string, checkBaseline = false) => ({
  planId,
  model,
  repository: { repoId: "n/terminus", commit },
  checkBaseline,
  validation: network.projectChecks,
  network,
  goal: "Build a feature",
})
const stoppedStream = (stopped: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `${JSON.stringify({ type: "harness_exit", exitCode: 0, stopped })}\n`
        )
      )
      controller.close()
    },
  })

function fixture(
  options: {
    testExit?: number
    harnessExit?: number
    /** False when the agent wrote no text part, only tool calls. */
    finalText?: boolean
  } = {}
) {
  const calls: { command: string[]; env?: Record<string, string> }[] = []
  const order: string[] = []
  let harnessRuns = 0
  const sandbox: StationSandbox = {
    // The real Sandbox restores a cache first; the install itself is the same.
    installDependencies: vi.fn(async (cwd: string) =>
      sandbox.run(["npm", "ci", "--no-audit", "--no-fund"], cwd)
    ),
    configure: vi.fn(async (network) => {
      order.push(`configure:${network.allowModel ? "model" : "git"}`)
    }),
    write: vi.fn(async (path: string) => {
      order.push(`write:${path}`)
    }),
    close: vi.fn(async () => {
      order.push("close")
    }),
    run: vi.fn(async (command: string[], _cwd, environment) => {
      calls.push({ command, env: environment })
      order.push(command.slice(0, 2).join(" "))
      const ok = { exitCode: 0, stdout: "", stderr: "" }
      if (command[1] === "--version") return { ...ok, stdout: "1.18.32" }
      if (command[0] === "git" && command[1] === "rev-parse")
        return { ...ok, stdout: `${commit}\n` }
      if (command[0] === "git" && command[1] === "ls-files")
        return { ...ok, stdout: ".env\0src/App.tsx\0config/key.pem\0" }
      if (command[0] === "npm" && command[1] === "test")
        return {
          exitCode: options.testExit ?? 0,
          stdout: "x".repeat(3000) + "1 failing",
          stderr: "",
        }
      if (command[0] === "bash")
        return { ...ok, exitCode: options.harnessExit ?? 0 }
      if (command[0] === "node" && command[1] === "-e")
        return {
          ...ok,
          stdout: JSON.stringify({
            path: "AGENTS.md",
            content: "Always add a changelog entry",
            truncated: false,
          }),
        }
      if (command[0] === "node") {
        harnessRuns++
        return {
          ...ok,
          stdout: [
            '{"sessionID":"ses_1"}',
            ...(options.finalText === false
              ? []
              : [`{"type":"text","part":{"text":"answer ${harnessRuns}"}}`]),
            '{"type":"tool_counts","counts":{"task:explore":2}}',
          ].join("\n"),
        }
      }
      return ok
    }),
  }
  const repositories = {
    access: vi.fn(
      async (
        repoId: string,
        scope: "read" | "write"
      ): Promise<RepositoryAccess> => ({
        repoId,
        scope,
        remote: `https://account.artifacts.cloudflare.net/git/default/${repoId}.git`,
        branch: "main",
        token: `token-${repoId}`,
        tokenId: repoId,
      })
    ),
    revoke: vi.fn(async () => {}),
  }
  const sessions = new SandboxDispatchSessions(
    {
      ...env,
      AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
      AI_GATEWAY_ID: "gateway",
      AI_GATEWAY_TOKEN: "worker-only-secret",
    },
    repositories,
    () => sandbox
  )
  const open = (
    checkBaseline = false,
    onActivity?: ActivityObserver,
    planId?: string
  ) =>
    sessions.open({
      planId,
      model,
      repository: { repoId: "n/terminus", commit },
      checkBaseline,
      validation: [{ name: "test", command: ["npm", "test"] }],
      network,
      onActivity,
    })
  return { sandbox, repositories, calls, order, open, sessions }
}

describe("Sandbox Dispatcher session", () => {
  it("reports actual preparation phases and streams filtered tools while preserving the final answer", async () => {
    const f = fixture()
    const activities: AgentActivity[] = []
    f.sandbox.runStream = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"type":"activity","activity":{"kind":"tool","tool":"read","status":"completed","path":"src/App.tsx"}}\n{"type":"harness_exit","exitCode":0}\n'
              )
            )
            controller.close()
          },
        })
    )
    const session = f.open(true, (activity) => {
      activities.push(activity)
    })
    await session.prepare()
    expect(await session.start("S", "Plan")).toBe("answer 1")
    await session.close()
    expect(
      activities.map((activity) =>
        activity.kind === "phase" ? activity.phase : activity.tool
      )
    ).toEqual([
      "preparing_workspace",
      "waiting_for_sandbox",
      "checking_out",
      "checking_baseline",
      "sealing_workspace",
      "starting_agent",
      "exploring",
      "read",
      "closing_workspace",
    ])
    expect(f.sandbox.runStream).toHaveBeenCalledWith(
      expect.arrayContaining(["/workspace/harness-live.mjs", "opencode"]),
      expect.any(String),
      expect.any(Object),
      15 * 60_000
    )
  })
  it("uses the live runner without an observer, so an accepted proposal ends the session", async () => {
    const f = fixture()
    f.sandbox.runStream = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"type":"harness_exit","exitCode":0,"stopped":"proposal_accepted"}\n'
              )
            )
            controller.close()
          },
        })
    )
    const session = f.open()
    await session.prepare()
    expect(await session.start("S", "Plan")).toBe("answer 1")
    expect(f.sandbox.runStream).toHaveBeenCalledWith(
      expect.arrayContaining(["/workspace/harness-live.mjs"]),
      expect.any(String),
      expect.any(Object),
      15 * 60_000
    )
    expect(f.calls.some(({ command }) => command[0] === "bash")).toBe(false)
  })
  it("finishes an accepted plan even when the agent wrote no closing message", async () => {
    const stream = (stopped?: string) =>
      vi.fn(
        async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ type: "harness_exit", exitCode: 0, stopped })}\n`
                )
              )
              controller.close()
            },
          })
      )
    // Stopped right after finalize_plan, before any text part.
    const accepted = fixture({ finalText: false })
    accepted.sandbox.runStream = stream("proposal_accepted")
    const session = accepted.open()
    await session.prepare()
    expect(await session.start("S", "Plan")).toBe("")
    // A run that ends on its own without an answer still fails.
    const silent = fixture({ finalText: false })
    silent.sandbox.runStream = stream()
    const unfinished = silent.open()
    await unfinished.prepare()
    await expect(unfinished.start("S", "Plan")).rejects.toThrow(
      "OpenCode did not produce a final message"
    )
  })
  it("ends the session with the last submission after repeated rejections", async () => {
    const f = fixture()
    f.sandbox.runStream = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"type":"harness_exit","exitCode":0,"stopped":"proposal_rejected"}\n'
              )
            )
            controller.close()
          },
        })
    )
    const session = f.open()
    await session.prepare()
    const error = await session
      .start("S", "Plan")
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ProposalSubmissionsExhausted)
    expect((error as ProposalSubmissionsExhausted).submission).toBe("answer 1")
  })
  it("starts an unverified legacy draft from nothing and reads what the plan tools saved", async () => {
    const plan = await seedDispatchPlan()
    const drafts = new DispatchDraftStore(env.DB)
    const station = {
      key: "a",
      name: "Station a",
      goal: "Deliver a",
      changeKind: "implementation" as const,
      changeDescription: "Implement a",
      scope: ["Only a"],
      expectedAreas: ["src/a.ts"],
      acceptanceCriteria: ["a works"],
    }
    // Left over from an earlier attempt.
    await drafts.save(plan.id, { stations: {} }, { stations: { a: station } })
    const f = fixture()
    const session = f.open(false, undefined, plan.id)
    await session.prepare()
    expect(f.sandbox.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({
        proposalCheck: { planId: plan.id, network, baseline: null },
      })
    )
    expect(await session.draft()).toEqual({ stations: {} })
    await drafts.save(plan.id, { stations: {} }, { stations: { a: station } })
    expect(await session.draft()).toEqual({ stations: { a: station } })
  })

  it("resumes the recorded native session after a format stall, even without a closing message", async () => {
    const f = fixture({ finalText: false })
    f.sandbox.runStream = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"type":"harness_exit","exitCode":0,"stopped":"proposal_stalled"}\n'
              )
            )
            controller.close()
          },
        })
    )
    const session = f.open()
    await session.prepare()
    await expect(session.start("S", "Plan")).rejects.toBeInstanceOf(
      PlanToolFormatStalled
    )
    await expect(session.resume("Use text lists")).rejects.toBeInstanceOf(
      PlanToolFormatStalled
    )
    expect(vi.mocked(f.sandbox.runStream).mock.calls[1]![0]).toEqual(
      expect.arrayContaining(["--session", "ses_1"])
    )
  })

  it("keeps checked baseline evidence and draft pieces when a new session retries", async () => {
    const plan = await seedDispatchPlan()
    const f = fixture()
    const drafts = new DispatchDraftStore(env.DB)
    const first = f.open(true, undefined, plan.id)
    const baseline = await first.prepare()
    const saved = partialDraft
    // No need for a complete proposal to retain successful draft writes.
    await drafts.save(plan.id, { stations: {} }, saved)
    await first.close()
    vi.mocked(f.sandbox.run).mockClear()
    vi.mocked(f.sandbox.installDependencies!).mockClear()
    const retry = f.open(true, undefined, plan.id)
    expect(await retry.restore()).toEqual({ draft: saved, baseline })
    expect(await retry.prepare()).toEqual(baseline)
    expect(await retry.draft()).toEqual(saved)
    expect(f.sandbox.installDependencies).not.toHaveBeenCalled()
    expect(
      vi
        .mocked(f.sandbox.run)
        .mock.calls.some(([command]) => command[0] === "npm")
    ).toBe(false)
  })

  it("reuses partial draft pieces after a harness stream fails and completes only the missing work", async () => {
    const plan = await seedDispatchPlan()
    const f = fixture()
    const drafts = new DispatchDraftStore(env.DB)
    f.sandbox.runStream = vi.fn(async () => {
      await drafts.save(plan.id, { stations: {} }, partialDraft)
      throw new Error("Lost harness stream")
    })
    const dispatcher = new HarnessDispatcher(model, f.sessions)
    const input = planningInput(plan.id, true)
    await expect(dispatcher.plan(input)).rejects.toThrow("Lost harness stream")
    expect(await drafts.read(plan.id)).toEqual(partialDraft)
    vi.mocked(f.sandbox.runStream).mockImplementationOnce(async (command) => {
      const saved = command
        .at(-1)!
        .split("\n")
        .find((line) => line.startsWith("{"))!
      expect(JSON.parse(saved)).toEqual(partialDraft)
      expect(command.at(-1)).toContain(
        "These Stations are in the outline but not saved: `b`"
      )
      await drafts.save(plan.id, partialDraft, completeDraft)
      return stoppedStream("proposal_accepted")
    })
    const result = await dispatcher.plan(input)
    expect(result.proposal.lines[0]!.stations.map((s) => s.key)).toEqual([
      "a",
      "b",
    ])
    expect(f.sandbox.installDependencies).toHaveBeenCalledOnce()
    expect(f.sandbox.runStream).toHaveBeenCalledTimes(2)
  })

  it("recovers a finished persisted draft without contacting repositories or the Sandbox", async () => {
    const plan = await seedDispatchPlan()
    const first = fixture()
    const session = first.open(true, undefined, plan.id)
    const baseline = await session.prepare()
    await new DispatchDraftStore(env.DB).save(
      plan.id,
      { stations: {} },
      completeDraft
    )
    await session.close()
    const retry = fixture()
    const result = await new HarnessDispatcher(model, retry.sessions).plan(
      planningInput(plan.id, true)
    )
    expect(result.baseline).toEqual(baseline)
    expect(result.proposal.lines[0]!.stations).toHaveLength(2)
    expect(retry.repositories.access).not.toHaveBeenCalled()
    expect(retry.sandbox.configure).not.toHaveBeenCalled()
    expect(retry.sandbox.run).not.toHaveBeenCalled()
    expect(retry.sandbox.close).not.toHaveBeenCalled()
  })

  it("refuses recovery across changed repository, baseline option, checks, model or harness", async () => {
    const plan = await seedDispatchPlan()
    const f = fixture()
    const input = planningInput(plan.id)
    await f.sessions.open(input).prepare()
    await new DispatchDraftStore(env.DB).save(
      plan.id,
      { stations: {} },
      partialDraft
    )
    for (const changed of [
      { repository: { ...input.repository, commit: "b".repeat(40) } },
      { repository: { ...input.repository, repoId: "other/terminus" } },
      { checkBaseline: true },
      { validation: [{ name: "test", command: ["npm", "run", "check"] }] },
      { model: "other-model" },
    ])
      expect(
        await f.sessions.open({ ...input, ...changed }).restore()
      ).toBeNull()
    const changedHarness = new SandboxDispatchSessions(
      env,
      f.repositories,
      () => f.sandbox,
      { harness: "codex", model }
    )
    expect(await changedHarness.open(input).restore()).toBeNull()
    // A changed check configuration gets a clean draft only after preparing successfully.
    const changed = f.sessions.open({
      ...input,
      validation: [{ name: "test", command: ["npm", "run", "check"] }],
    })
    await changed.prepare()
    expect(await changed.draft()).toEqual({ stations: {} })
  })
  it("checks out read-only, seals secrets and history, then allows only the model", async () => {
    const f = fixture()
    const session = f.open()
    expect(await session.prepare()).toBeNull()
    expect(f.sandbox.configure).toHaveBeenNthCalledWith(1, {
      repositories: [
        {
          remote: expect.stringContaining("n/terminus"),
          token: "token-n/terminus",
          scope: "read",
        },
      ],
      allowModel: false,
    })
    // The plan tools check against the same context the plan is reviewed with.
    expect(f.sandbox.configure).toHaveBeenLastCalledWith({
      repositories: [],
      allowModel: true,
      model,
      proposalCheck: { planId: expect.any(String), network, baseline: null },
    })
    expect(f.repositories.access).toHaveBeenCalledWith("n/terminus", "read")
    expect(f.repositories.revoke).toHaveBeenCalledOnce()
    expect(f.calls.map((c) => c.command)).toContainEqual([
      "rm",
      "-f",
      "--",
      ".env",
      "config/key.pem",
    ])
    expect(f.calls.map((c) => c.command)).toContainEqual([
      "rm",
      "-rf",
      "--",
      ".git",
    ])
    expect(f.calls.some((c) => c.command[0] === "npm")).toBe(false)
    expect(f.order.indexOf("rm -rf")).toBeLessThan(
      f.order.lastIndexOf("configure:model")
    )
  })

  it("runs trusted checks before sealing and reports trimmed results", async () => {
    const f = fixture({ testExit: 1 })
    const baseline = await f.open(true).prepare()
    expect(baseline).toMatchObject({
      commit,
      checks: [
        { name: "npm ci", status: "passed" },
        { name: "test", status: "failed", exitCode: 1 },
      ],
    })
    const tail = baseline!.checks[1]!.outputTail
    expect(tail).toHaveLength(2000)
    expect(tail.endsWith("1 failing")).toBe(true)
    expect(f.order.indexOf("npm test")).toBeLessThan(f.order.indexOf("rm -rf"))
    expect(f.order.indexOf("npm test")).toBeLessThan(
      f.order.indexOf("configure:model")
    )
  })

  it("starts the read-only Dispatcher agent and resumes the recorded session", async () => {
    const f = fixture()
    const session = f.open()
    await session.prepare()
    expect(await session.start("SYSTEM PROMPT", "Plan it")).toBe("answer 1")
    const config = JSON.parse(
      vi
        .mocked(f.sandbox.write)
        .mock.calls.find(([path]) => path === "/workspace/opencode.json")![1]
    )
    expect(config.agent.dispatcher.prompt).toMatch(
      /^SYSTEM PROMPT\n\n## Repository Content\n/
    )
    expect(config.agent.dispatcher.permission.edit).toBe("deny")
    const harness = f.calls.find((c) => c.command[0] === "bash")!
    expect(harness.command.slice(0, 4)).toEqual([
      "bash",
      "-c",
      'exec "$@" > "$0"',
      "/workspace/harness-session-1.jsonl",
    ])
    expect(harness.command).toContain("dispatcher")
    // Root guidance is read from the sealed checkout and supplied as data.
    expect(f.order.indexOf("rm -rf")).toBeLessThan(f.order.indexOf("node -e"))
    expect(f.order.indexOf("node -e")).toBeLessThan(f.order.indexOf("bash -c"))
    const message = harness.command.at(-1)!
    expect(message.startsWith("Plan it\n\n")).toBe(true)
    expect(message).toMatch(
      /<repository-guidance boundary="([\w-]+)">\nAlways add a changelog entry\n<\/repository-guidance boundary="\1">$/
    )
    expect(harness.env).toMatchObject({
      OPENCODE_CONFIG: "/workspace/opencode.json",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    })
    expect(JSON.stringify(harness.env)).not.toContain("worker-only-secret")
    expect(await session.resume("Fix it")).toBe("answer 2")
    const resumed = f.calls.filter((c) => c.command[0] === "bash")[1]!
    expect(resumed.command).toEqual(
      expect.arrayContaining(["--session", "ses_1"])
    )
    await session.close()
    expect(f.sandbox.close).toHaveBeenCalledOnce()
  })

  it("fails on a harness error and revokes access when preparation is interrupted", async () => {
    const failing = fixture({ harnessExit: 1 })
    const session = failing.open()
    await session.prepare()
    await expect(session.start("S", "Plan")).rejects.toThrow("exited with 1")
    const f = fixture()
    vi.mocked(f.sandbox.run).mockRejectedValueOnce(new Error("lost"))
    const interrupted = f.open()
    await expect(interrupted.prepare()).rejects.toThrow("lost")
    await interrupted.close()
    expect(f.repositories.revoke).toHaveBeenCalledOnce()
    expect(f.sandbox.close).toHaveBeenCalledOnce()
  })
})
