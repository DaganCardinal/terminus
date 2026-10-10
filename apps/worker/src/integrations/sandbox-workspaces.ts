import type {
  GitWorkspace,
  GitWorkspaceFactory,
  RepositoryAccess,
} from "@terminus/artifacts"
import { commandResultSchema } from "@terminus/protocol"

export class SandboxWorkspaces implements GitWorkspaceFactory {
  readonly #env: Env
  constructor(env: Env) {
    this.#env = env
  }

  async open(access: RepositoryAccess[]): Promise<GitWorkspace> {
    const sandbox = this.#env.SANDBOX.getByName(`git-${crypto.randomUUID()}`)
    await sandbox.configure({
      repositories: access.map(({ remote, token, scope }) => ({
        remote,
        token,
        scope,
      })),
      allowModel: false,
    })
    return {
      run: async (command, cwd, env) =>
        commandResultSchema.parse(await sandbox.run(command, cwd, env)),
      install: async (cwd) =>
        commandResultSchema.parse(await sandbox.installDependencies(cwd)),
      close: () => sandbox.close(),
    }
  }
}
