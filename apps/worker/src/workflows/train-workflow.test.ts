import { env } from "cloudflare:test"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { afterEach, expect, it, vi } from "vitest"
import * as rolePorts from "../agents/ports"
import { testPorts } from "../../test/fixtures"
import * as conflictWatch from "./conflict-watch-operations"
import * as engineer from "./engineer-operations"
import type { TrainWorkflowParams } from "./events"
import * as train from "./train-operations"
import { TrainWorkflow } from "./train-workflow"

afterEach(() => vi.restoreAllMocks())

it.each(["persistence", "launch"])(
  "continues after exhausted advisory %s retries and retries the watch while held",
  async (failure) => {
    const ports = testPorts().train
    vi.spyOn(rolePorts, "trainModels").mockResolvedValue({
      dispatcher: "fake",
      conductor: "fake",
      stationAgent: "fake",
      technician: "fake",
      engineer: "fake",
    })
    vi.spyOn(rolePorts, "trainPorts").mockReturnValue(ports)
    vi.spyOn(engineer, "observeEngineer").mockResolvedValue()
    const advance = vi
      .spyOn(train, "advanceTrain")
      .mockResolvedValueOnce({ kind: "moved" })
      .mockResolvedValueOnce({ kind: "await_wake" })
      .mockResolvedValueOnce({ kind: "finished", status: "unloaded" })
    const watch = vi
      .spyOn(conflictWatch, "watchNewCars")
      .mockRejectedValueOnce(new Error(`${failure} retries exhausted`))
      .mockResolvedValue()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // A rejected do() represents a durable step whose retries are exhausted.
    const step = {
      do: vi.fn(async (_name, _config, callback: () => Promise<unknown>) =>
        callback()
      ),
      waitForEvent: vi.fn(async () => ({ payload: {} })),
    } as unknown as WorkflowStep
    // Exercise the movement loop without constructing a native Workflow instance.
    const workflow = { env, run: TrainWorkflow.prototype.run }
    const event = {
      payload: { trainId: "train-test" },
    } as WorkflowEvent<TrainWorkflowParams>

    await expect(workflow.run(event, step)).resolves.toEqual({
      kind: "finished",
      status: "unloaded",
    })
    expect(advance).toHaveBeenCalledTimes(3)
    expect(watch).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith("Dispatcher conflict watch deferred", {
      trainId: "train-test",
      leg: 1,
    })
  }
)
