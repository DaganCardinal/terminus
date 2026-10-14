import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const exec = promisify(execFile)
async function fixture(failLine = false) {
  const root = await mkdtemp(join(tmpdir(), "terminus-observer-"))
  const transport = join(root, "transport.mjs")
  const output = join(root, "run")
  await writeFile(
    transport,
    `
    import { writeFileSync } from "node:fs";
    const requests = []; const lines = []; let released = false;
    const baseline = "a".repeat(40);
    const events = Array.from({length: 10}, (_, i) => ["train.departed", "terminus.integration_requested", "terminus.clearance_granted", "terminus.promoted"].map((type, j) => ({seq: i * 4 + j + 1, occurredAt: new Date((i * 10 + j) * 1000).toISOString(), event: {type, trainId: "t" + i}}))).flat();
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname; const method = init.method;
      requests.push({path, method, authenticated: !!init.headers["cf-access-jwt-assertion"]});
      writeFileSync(${JSON.stringify(join(root, "requests.json"))}, JSON.stringify(requests));
      const json = (data) => Response.json(data);
      if (path === "/api/stress-test") return json({profile: "ten-trains-v1", repositoryMode: "artifacts"});
      if (path === "/api/stress-tests") {
        ${failLine ? 'return new Response(JSON.stringify({error: "Artifacts unavailable"}), {status: 503});' : 'released = true; lines.push(...Array.from({length: 10}, () => ({}))); return json({profile: "ten-trains-v1", runId: JSON.parse(init.body).requestId, networkId: "n", baseline, mode: "artifacts"});'}
      }
      if (path.endsWith("/stress-test/verify")) return json({commit: "b".repeat(40), files: 20, reachableCars: 10, mergeCommits: Array.from({length: 10}, (_, i) => String(i).padStart(40, "0"))});
      if (path.endsWith("/stress-test")) return json({profile: "ten-trains-v1", leases: 0, expiredLeases: 0, activeIntegrations: 0, completedIntegrations: released ? 10 : 0, failedIntegrations: 0});
      if (path.endsWith("/events")) return json({events: Number(new URL(url).searchParams.get("after")) ? [] : events, lastSeq: 40});
      if (path === "/api/perf-logs") return json({complete: true, records: []});
      return json({network: {id: "n", terminusCommit: baseline, validation: ["typecheck", "test", "build"].map(name => ({name, command: ["npm", "run", name]}))}, lines, stations: released ? lines.map((line, i) => ({id: "s" + i, revisionCount: 0, state: {status: "complete"}})) : [], trains: released ? lines.map((line, i) => ({train: {id: "t" + i, state: {status: "unloaded"}}})) : [], cars: [], holds: [], plans: [], conflicts: [], lastSeq: released ? 40 : 0});
    };
  `
  )
  let exit = 0
  try {
    await exec(
      process.execPath,
      [
        "--import",
        transport,
        resolve("src/main.ts"),
        "--network",
        "n",
        "--output",
        output,
      ],
      { env: { ...process.env, CF_ACCESS_TOKEN: "fixture.login.token" } }
    )
  } catch {
    exit = 1
  }
  return {
    root,
    output,
    exit,
    requests: JSON.parse(
      await readFile(join(root, "requests.json"), "utf8")
    ) as { path: string; method: string; authenticated: boolean }[],
  }
}

it("uses one backend launch command, verifies the run, and never journals authentication", async () => {
  const f = await fixture()
  try {
    expect(f.exit).toBe(0)
    const mutations = f.requests.filter((request) => request.method !== "GET")
    expect(mutations.map((request) => request.path)).toEqual([
      "/api/stress-tests",
      "/api/networks/n/stress-test/verify",
    ])
    expect(f.requests.every((request) => request.authenticated)).toBe(true)
    const report = await readFile(join(f.output, "report.json"), "utf8")
    expect(JSON.parse(report)).toMatchObject({
      passed: true,
      verification: { files: 20, reachableCars: 10 },
    })
    expect(report).not.toContain("fixture.login.token")
    expect(await readFile(join(f.output, "run.json"), "utf8")).not.toContain(
      "fixture.login.token"
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

it("journals a failed launch and never automatically retries the mutation", async () => {
  const f = await fixture(true)
  try {
    expect(f.exit).toBe(1)
    expect(
      f.requests.filter((request) => request.path === "/api/stress-tests")
    ).toHaveLength(1)
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(
      false
    )
    expect(
      JSON.parse(await readFile(join(f.output, "run.json"), "utf8"))
    ).not.toHaveProperty("launchComplete")
    expect(
      JSON.parse(await readFile(join(f.output, "report.json"), "utf8"))
    ).toMatchObject({
      passed: false,
      failure: "POST /stress-tests returned 503:\n  Artifacts unavailable",
    })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
