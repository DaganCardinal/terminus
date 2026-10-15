import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import type { GitWorkspace } from "./git"
import { isSecretPath } from "./repository-browse"
import {
  secretFilePatch,
  secretFilePatches,
  withoutSecrets,
} from "./secret-diff"

const execute = promisify(execFile)
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "terminus-secret-diff-"))
  temporary.push(root)
  const g = async (...args: string[]) =>
    (
      await execute(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
        { cwd: root }
      )
    ).stdout
  await g("init", "-b", "main")
  const commit = async () => {
    await g("add", "-A")
    await g("commit", "--allow-empty", "-m", "Commit")
    return (await g("rev-parse", "HEAD")).trim()
  }
  const write = async (path: string, contents: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  const workspace: GitWorkspace = {
    run: async (command, cwd = root) => ({
      exitCode: 0,
      ...(await execute(command[0]!, command.slice(1), { cwd })),
    }),
    close: async () => {},
  }
  return { root, g, commit, write, workspace }
}

describe("secret files in diffs", () => {
  it("selects exactly the files isSecretPath does", async () => {
    const r = await repository()
    const base = await r.commit()
    const paths = [
      ".env",
      ".env.local",
      "upper/.ENV",
      "a/b/.env.prod",
      ".dev.vars",
      "x/.dev.vars.local",
      "credentials",
      "credentials.json",
      "a/Credentials.yml",
      "key.pem",
      "a/b/c.PEM",
      ".pem",
      "id.key",
      "a/x.Key",
      "sp ace/.env",
      "tab\tx.pem",
      "envfile",
      "a.env",
      "x.envy",
      "a/.envrc/notes.txt",
      "notes.txt",
      "pem",
      "a/keys/file.txt",
      "credentialsdir/x.txt",
      "my.key.txt",
    ]
    for (const path of paths) await r.write(path, "value\n")
    const head = await r.commit()
    const shown = (
      await r.g(
        "diff",
        "--name-only",
        "-z",
        base,
        head,
        "--",
        ...withoutSecrets
      )
    )
      .split("\0")
      .filter(Boolean)
    expect(shown.sort()).toEqual(
      paths.filter((path) => !isSecretPath(path)).sort()
    )
    const withheld = await secretFilePatches(r.workspace, base, head, r.root)
    expect(
      [...withheld.matchAll(/^diff --git a\/(.*) b\//gm)]
        .map((match) => match[1])
        .sort()
    ).toEqual(paths.filter(isSecretPath).sort())
    expect(withheld).not.toContain("value")
  })

  it("lists secret changes by path and mode, never contents or object IDs", async () => {
    const r = await repository()
    await r.write(".env", "API_KEY=first\n")
    await r.write(".env.local", "LOCAL=1\n")
    await r.write("credentials.json", '{"token":"gone"}\n')
    await r.write("tls/server.pem", "PEM\n")
    await r.write("notes.txt", "visible\n")
    const base = await r.commit()
    await r.write(".env", "API_KEY=second\n")
    await rm(join(r.root, ".env.local"))
    await symlink("notes.txt", join(r.root, ".env.local"))
    await rm(join(r.root, "credentials.json"))
    await chmod(join(r.root, "tls/server.pem"), 0o755)
    await r.write("id.key", "PRIVATE\n")
    await r.write("notes.txt", "still visible\n")
    const head = await r.commit()
    const withheld = await secretFilePatches(r.workspace, base, head, r.root)
    expect(withheld).toBe(
      [
        "diff --git a/.env b/.env",
        "Secret file contents withheld",
        "diff --git a/.env.local b/.env.local",
        "deleted file mode 100644",
        "Secret file contents withheld",
        "diff --git a/.env.local b/.env.local",
        "new file mode 120000",
        "Secret file contents withheld",
        "diff --git a/credentials.json b/credentials.json",
        "deleted file mode 100644",
        "Secret file contents withheld",
        "diff --git a/id.key b/id.key",
        "new file mode 100644",
        "Secret file contents withheld",
        "diff --git a/tls/server.pem b/tls/server.pem",
        "old mode 100644",
        "new mode 100755",
        "",
      ].join("\n")
    )
    expect(withheld).not.toMatch(/[0-9a-f]{40}/)
    const shown = await r.g(
      "diff",
      "--full-index",
      base,
      head,
      "--",
      ...withoutSecrets
    )
    expect(shown).toContain("+still visible")
    expect(shown).not.toMatch(/API_KEY|LOCAL|token|PEM|PRIVATE/)
  })

  it("formats one secret file the same from objects or from Git", () => {
    expect(
      secretFilePatch(
        ".env",
        { mode: "100644", hash: "a".repeat(40) },
        { mode: "100644", hash: "b".repeat(40) }
      )
    ).toBe("diff --git a/.env b/.env\nSecret file contents withheld\n")
    expect(
      secretFilePatch(".env", undefined, { mode: "100644", hash: "b" })
    ).toBe(
      "diff --git a/.env b/.env\nnew file mode 100644\nSecret file contents withheld\n"
    )
  })
})
