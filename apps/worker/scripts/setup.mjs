// Sets Terminus up in your Cloudflare account from your Wrangler login: the
// account, D1 database and dependency cache, the runtime token, a deploy,
// Cloudflare Access and signed-out/signed-in checks. Re-runs apply migrations
// and deploy again, including after an interrupted deploy. See docs/live-setup.md.
//
//   npm run setup                     set up and deploy
//   npm run setup -- --local          set up `npm run dev:worker` instead
//   npm run setup -- --check          report what is set up, changing nothing
//
// CLOUDFLARE_RUNTIME_TOKEN and ACCESS_ALLOWED_EMAILS in the environment answer
// their prompts. TERMINUS_ACCESS_TOKEN supplies a temporary user Access token
// for the signed-in check; it is never saved or deployed.
import { spawn, spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { experimental_patchConfig } from "wrangler"
import {
  deploymentConfig,
  LOCAL_CONFIG,
  readConfig,
  workerPath,
  wranglerBin,
} from "./config.mjs"

export async function setup(args = process.argv.slice(2)) {
  const options = new Set(args)
  for (const option of options)
    if (!["--check", "--local"].includes(option)) {
      console.error(`Unknown option ${option}. Options: --check, --local.`)
      return 2
    }
  const check = options.has("--check")
  const local = options.has("--local")
  const rerun = local ? "npm run setup -- --local" : "npm run setup"

  /** A problem the person running setup can fix; reported without a stack. */
  class SetupError extends Error {}

  const step = (title) => console.log(`\n${title}`)
  const ok = (text) => console.log(`  ✓ ${text}`)
  const note = (text) => console.log(`    ${text}`)
  let problems = 0
  const problem = (text) => {
    problems++
    console.log(`  ✗ ${text}`)
  }
  /** An answer that is asked for again; only giving up counts as a problem. */
  const rejected = (text) => console.log(`  ✗ ${text}`)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** Placeholders from the example file count as unset. */
  const isSet = (value) =>
    typeof value === "string" && value !== "" && !value.includes("YOUR_")

  const PERMISSIONS = [
    "Artifacts: Read and Edit",
    "Workers AI: Read",
    "AI Gateway: Run (for Anthropic and OpenAI models)",
  ]

  // Prompts. Hidden input mutes readline's echo. `otherwise` says how to answer
  // without a terminal.
  let reader
  let muted = false
  function prompts(otherwise) {
    if (!process.stdin.isTTY)
      throw new SetupError(
        `Setup needs an answer here: run it in a terminal, or ${otherwise}.`
      )
    if (!reader) {
      reader = createInterface({
        input: process.stdin,
        output: new Writable({
          write(chunk, _, done) {
            if (!muted) process.stdout.write(chunk)
            done()
          },
        }),
        terminal: true,
      })
      reader.on("SIGINT", () => {
        process.stdout.write("\n")
        process.exit(130)
      })
    }
    return reader
  }
  async function ask(question, otherwise, fallback) {
    const answer = await prompts(otherwise).question(
      `    ${question}${fallback ? ` [${fallback}]` : ""} `
    )
    return answer.trim() || fallback || ""
  }
  async function askSecret(question, otherwise) {
    const input = prompts(otherwise)
    process.stdout.write(`    ${question} `)
    muted = true
    try {
      return (await input.question("")).trim()
    } finally {
      muted = false
      process.stdout.write("\n")
    }
  }

  /**
   * Runs a command in this terminal. The prompt reader keeps the terminal raw,
   * where Ctrl-C reaches no process, so it is closed first and the next prompt
   * reopens it. While the command runs, Ctrl-C stops only the command, so setup
   * still cleans up and reports it.
   */
  function runInTerminal(command, args, options = {}) {
    reader?.close()
    reader = undefined
    const ignore = () => undefined
    process.on("SIGINT", ignore)
    try {
      return spawnSync(command, args, {
        cwd: workerPath(),
        stdio: "inherit",
        ...options,
      })
    } finally {
      process.off("SIGINT", ignore)
    }
  }

  function openInBrowser(url) {
    if (check || !process.stdout.isTTY) return
    const [command, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]]
    const child = spawn(command, args, { stdio: "ignore", detached: true })
    child.on("error", () => undefined)
    child.unref()
  }

  /** Runs a Wrangler command that answers in JSON, even when it exits nonzero. */
  function wranglerJson(args) {
    const { stdout, stderr } = spawnSync(
      process.execPath,
      [wranglerBin, ...args],
      {
        cwd: workerPath(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    try {
      return JSON.parse(stdout.slice(stdout.search(/[[{]/)))
    } catch {
      throw new SetupError(
        `\`wrangler ${args.join(" ")}\` failed:\n${(stderr || stdout).trim()}`
      )
    }
  }

  async function api(token, path, init = {}) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      }
    ).catch((error) => {
      throw new SetupError(
        `Couldn't reach the Cloudflare API: ${error.message}`
      )
    })
    const body = await response.json().catch(() => null)
    return {
      status: response.status,
      ok: Boolean(body?.success),
      result: body?.result,
      errors: body?.errors ?? [],
    }
  }
  const failure = (response) =>
    response.errors.map((error) => error.message).join("; ") ||
    `HTTP ${response.status}`

  // wrangler.local.jsonc
  let changed = false
  const localConfig = () =>
    existsSync(workerPath(LOCAL_CONFIG)) ? readConfig(LOCAL_CONFIG) : {}
  async function patchLocal(values) {
    const file = workerPath(LOCAL_CONFIG)
    experimental_patchConfig(file, values, false)
    changed = true
    // Wrangler's patch re-indents the file; restore the repository's style.
    try {
      const prettier = await import("prettier")
      const options = await prettier.resolveConfig(file)
      writeFileSync(
        file,
        await prettier.format(readFileSync(file, "utf8"), {
          ...options,
          filepath: file,
        })
      )
    } catch {
      // Formatting is cosmetic.
    }
  }

  async function signIn() {
    step("Cloudflare sign-in")
    let who = wranglerJson(["whoami", "--json"])
    if (!who.loggedIn) {
      if (check)
        throw new SetupError(`Wrangler isn't signed in. Run \`${rerun}\`.`)
      const login = runInTerminal(process.execPath, [wranglerBin, "login"])
      if (login.status !== 0)
        throw new SetupError("Wrangler sign-in didn't finish.")
      who = wranglerJson(["whoami", "--json"])
      if (!who.loggedIn) throw new SetupError("Wrangler sign-in didn't finish.")
    }
    let token = wranglerToken()
    ok(`Signed in${who.email ? ` as ${who.email}` : ""}`)

    // Wrangler renews its short-lived OAuth token only once it has expired, so
    // a deploy or a long prompt can outlast the token read here. A refused call
    // is retried once if Wrangler's current token differs.
    async function cf(path, init) {
      const response = await api(token, path, init)
      if (response.status !== 401 && response.status !== 403) return response
      const current = wranglerToken()
      if (current === token) return response
      token = current
      return api(token, path, init)
    }
    return { who, cf }
  }

  function wranglerToken() {
    const { token } = wranglerJson(["auth", "token", "--json"])
    if (!token)
      throw new SetupError(
        "Couldn't use Wrangler's credentials. Sign in with `npx wrangler login`, or set CLOUDFLARE_API_TOKEN."
      )
    return token
  }

  async function chooseAccount(who) {
    step("Account")
    const accounts = who.accounts ?? []
    const configured = localConfig().account_id
    let account = isSet(configured)
      ? configured
      : process.env.CLOUDFLARE_ACCOUNT_ID
    if (account) {
      const known = accounts.find((entry) => entry.id === account)
      if (accounts.length && !known)
        throw new SetupError(
          `Account ${account} isn't one of this login's accounts. Fix account_id in apps/worker/${LOCAL_CONFIG}.`
        )
      ok(`${known?.name ?? "Account"} (${account})`)
    } else if (check) {
      throw new SetupError(
        `No account_id in apps/worker/${LOCAL_CONFIG}. Run \`${rerun}\`.`
      )
    } else if (accounts.length === 1) {
      account = accounts[0].id
      ok(`${accounts[0].name} (${account})`)
    } else {
      const otherwise = `set account_id in apps/worker/${LOCAL_CONFIG} or CLOUDFLARE_ACCOUNT_ID`
      if (accounts.length) {
        accounts.forEach((entry, index) =>
          note(`${index + 1}. ${entry.name} (${entry.id})`)
        )
        while (!account)
          account =
            accounts[Number(await ask("Which account?", otherwise)) - 1]?.id
        ok(`Using ${account}`)
      } else {
        while (!/^[a-f0-9]{32}$/.test(account ?? ""))
          account = await ask("Cloudflare account ID:", otherwise)
      }
    }

    if (check) return account
    if (!existsSync(workerPath(LOCAL_CONFIG))) {
      copyFileSync(
        workerPath("wrangler.local.example.jsonc"),
        workerPath(LOCAL_CONFIG)
      )
      // The example's placeholders stay empty until setup fills them in.
      await patchLocal({
        account_id: account,
        vars: { APP_ORIGIN: "", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" },
      })
      ok(`Created apps/worker/${LOCAL_CONFIG}`)
    } else if (localConfig().account_id !== account) {
      await patchLocal({ account_id: account })
    }
    return account
  }

  /** Checks token status and read access, without writes or paid model calls. */
  async function runtimeToken(account) {
    // An empty variable is unset, so it never stands in for the prompt.
    const provided = process.env.CLOUDFLARE_RUNTIME_TOKEN || undefined
    if (!provided) {
      const url = `https://dash.cloudflare.com/${account}/api-tokens`
      note("Terminus needs one account API token. Create it at")
      note(url)
      note("with these permissions:")
      for (const permission of PERMISSIONS) note(`  ${permission}`)
      openInBrowser(url)
    }
    for (let attempt = 1; ; attempt++) {
      const token =
        provided ??
        (await askSecret("Paste the token:", "set CLOUDFLARE_RUNTIME_TOKEN"))
      const issues = await tokenIssues(account, token)
      if (!issues.length) {
        ok(
          "The supplied token is active; Artifacts and Workers AI read probes passed"
        )
        note(
          "Not verified: Artifacts Edit. Confirm it in the token's permissions before running work."
        )
        const vars = deploymentConfig().vars ?? {}
        if (
          vars.ALTERNATIVE_HARNESSES_ENABLED === "true" ||
          vars.OPENCODE_EXTERNAL_PROVIDERS_ENABLED === "true"
        )
          note(
            "Not verified: AI Gateway Run for enabled Anthropic/OpenAI routes. Confirm it in the token's permissions before using those models."
          )
        note(
          "These read-only probes do not test repository writes or model execution."
        )
        return token
      }
      for (const issue of issues) rejected(issue)
      if (provided || attempt === 3)
        throw new SetupError("Fix the token, then run setup again.")
    }
  }

  async function tokenIssues(account, token) {
    if (!token) return ["No token was entered."]
    let verified = await api(token, `accounts/${account}/tokens/verify`)
    // Only fall back for a different token type, never for a known inactive token.
    if (!verified.ok) verified = await api(token, "user/tokens/verify")
    const details = verified.result
    const now = Date.now()
    if (
      !verified.ok ||
      details?.status !== "active" ||
      (details.expires_on != null && !(Date.parse(details.expires_on) > now)) ||
      (details.not_before != null && !(Date.parse(details.not_before) <= now))
    )
      return ["That token isn't valid or active."]
    const issues = []
    // The account-level route works without assuming a namespace already exists.
    if (
      !(await api(token, `accounts/${account}/artifacts/namespaces?limit=1`)).ok
    )
      issues.push(
        "The Artifacts read probe failed: check Artifacts Read and the selected account."
      )
    if (
      !(await api(token, `accounts/${account}/ai/models/search?per_page=1`)).ok
    )
      issues.push("It can't reach Workers AI: add Workers AI Read.")
    return issues
  }

  async function appOrigin(cf, account, name) {
    step("App URL")
    const configured = localConfig().vars?.APP_ORIGIN
    if (isSet(configured)) {
      const origin = publicOrigin(configured)
      ok(origin)
      return origin
    }
    const subdomain = await cf(`accounts/${account}/workers/subdomain`)
    if (!subdomain.ok || !subdomain.result?.subdomain) {
      if (check) problem("No APP_ORIGIN, and no workers.dev subdomain yet")
      else
        note(
          "Your account has no workers.dev subdomain yet; Wrangler offers to register one when it deploys."
        )
      return null
    }
    const origin = `https://${name}.${subdomain.result.subdomain}.workers.dev`
    if (check) {
      problem(`APP_ORIGIN isn't set (it would be ${origin})`)
      return null
    }
    await patchLocal({ vars: { APP_ORIGIN: origin } })
    ok(origin)
    return origin
  }

  /** Never send an Access credential to a URL with credentials, a path or HTTP. */
  function publicOrigin(value) {
    try {
      const url = new URL(value)
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.hostname.endsWith(".localhost")
      )
        return url.origin
    } catch {
      // Report configuration errors without echoing possible URL credentials.
    }
    throw new SetupError(
      "APP_ORIGIN must be the public HTTPS origin, without credentials, a path, query or fragment."
    )
  }

  async function resources(cf, account, config) {
    step("Database and dependency cache")
    const database = config.d1_databases.find(
      (entry) => entry.binding === "DB"
    ).database_name
    const databases = await cf(
      `accounts/${account}/d1/database?name=${encodeURIComponent(database)}`
    )
    if (!databases.ok)
      throw new SetupError(`Couldn't list D1 databases: ${failure(databases)}`)
    if (databases.result.some((entry) => entry.name === database))
      ok(`D1 database ${database}`)
    else if (check) problem(`No D1 database ${database}`)
    else {
      const created = await cf(`accounts/${account}/d1/database`, {
        method: "POST",
        body: JSON.stringify({ name: database }),
      })
      if (!created.ok)
        throw new SetupError(
          `Couldn't create D1 ${database}: ${failure(created)}`
        )
      ok(`Created D1 database ${database}`)
    }

    const bucket = config.r2_buckets.find(
      (entry) => entry.binding === "DEPENDENCY_CACHE"
    ).bucket_name
    const existing = await cf(`accounts/${account}/r2/buckets/${bucket}`)
    if (existing.ok) ok(`R2 bucket ${bucket}`)
    else if (existing.status !== 404)
      throw new SetupError(`Couldn't read R2 ${bucket}: ${failure(existing)}`)
    else if (check) {
      problem(`No R2 bucket ${bucket}`)
      return
    } else {
      const created = await cf(`accounts/${account}/r2/buckets`, {
        method: "POST",
        body: JSON.stringify({ name: bucket }),
      })
      if (!created.ok)
        throw new SetupError(
          `Couldn't create R2 ${bucket}: ${failure(created)}`
        )
      ok(`Created R2 bucket ${bucket}`)
    }

    // Cached npm downloads are disposable; expired entries are rebuilt.
    const lifecycle = await cf(
      `accounts/${account}/r2/buckets/${bucket}/lifecycle`
    )
    if (!lifecycle.ok)
      throw new SetupError(
        `Couldn't read ${bucket}'s lifecycle: ${failure(lifecycle)}`
      )
    const rules = lifecycle.result.rules ?? []
    const retentionSeconds = 30 * 86_400
    const cachePrefix = "npm/"
    if (
      rules.some((rule) => {
        const prefix = rule.conditions?.prefix
        const condition = rule.deleteObjectsTransition?.condition
        return (
          rule.enabled === true &&
          typeof prefix === "string" &&
          cachePrefix.startsWith(prefix) &&
          condition?.type === "Age" &&
          condition.maxAge === retentionSeconds
        )
      })
    )
      ok(`${bucket} has an enabled 30-day expiry covering ${cachePrefix}`)
    else if (check)
      problem(`${bucket} has no enabled 30-day expiry covering ${cachePrefix}`)
    else {
      const saved = await cf(
        `accounts/${account}/r2/buckets/${bucket}/lifecycle`,
        {
          method: "PUT",
          headers: { "cf-r2-data-catalog-check": "true" },
          body: JSON.stringify({
            rules: [
              ...rules.filter((rule) => rule.id !== "expire-cache"),
              {
                id: "expire-cache",
                enabled: true,
                conditions: { prefix: "" },
                deleteObjectsTransition: {
                  condition: { type: "Age", maxAge: retentionSeconds },
                },
              },
            ],
          }),
        }
      )
      if (!saved.ok)
        throw new SetupError(
          `Couldn't add ${bucket}'s expiry: ${failure(saved)}`
        )
      ok(`${bucket} now expires entries after 30 days`)
    }
  }

  async function workerSecrets(cf, account, name, who) {
    step("Worker secrets")
    const listed = await cf(
      `accounts/${account}/workers/scripts/${name}/secrets`
    )
    if (!listed.ok && listed.status !== 404)
      throw new SetupError(
        `Couldn't read ${name}'s secrets: ${failure(listed)}`
      )
    const names = new Set(
      listed.ok ? listed.result.map((entry) => entry.name) : []
    )
    const pending = {}

    // Environment answers are candidates for the next deploy, never evidence
    // about the encrypted values currently installed on the Worker.
    if (check) {
      if (names.has("CLOUDFLARE_RUNTIME_TOKEN"))
        ok(
          "CLOUDFLARE_RUNTIME_TOKEN secret is deployed (value and permissions not checked)"
        )
      else if (
        names.has("ARTIFACTS_API_TOKEN") &&
        names.has("AI_GATEWAY_TOKEN")
      )
        ok(
          "ARTIFACTS_API_TOKEN and AI_GATEWAY_TOKEN are deployed (values and permissions not checked)"
        )
      else
        problem(
          "No CLOUDFLARE_RUNTIME_TOKEN secret (or complete older pair) is deployed"
        )
      if (names.has("ACCESS_ALLOWED_EMAILS"))
        ok("ACCESS_ALLOWED_EMAILS secret is deployed")
      else problem("No ACCESS_ALLOWED_EMAILS secret is deployed")

      if (process.env.CLOUDFLARE_RUNTIME_TOKEN) {
        note(
          "Environment CLOUDFLARE_RUNTIME_TOKEN is available to deploy; --check does not install it or verify the deployed token's value."
        )
        await runtimeToken(account)
      }
      const suppliedEmails = process.env.ACCESS_ALLOWED_EMAILS
      const emails = suppliedEmails ? allowedEmails(suppliedEmails) : undefined
      if (suppliedEmails && !emails)
        throw new SetupError("ACCESS_ALLOWED_EMAILS isn't a list of emails.")
      if (emails)
        note(
          "Environment ACCESS_ALLOWED_EMAILS is available to deploy; --check does not install it or verify the deployed allowlist's value."
        )
      return { pending, emails }
    }

    if (process.env.CLOUDFLARE_RUNTIME_TOKEN) {
      const token = await runtimeToken(account)
      pending.CLOUDFLARE_RUNTIME_TOKEN = token
    } else if (names.has("CLOUDFLARE_RUNTIME_TOKEN")) {
      ok(
        "CLOUDFLARE_RUNTIME_TOKEN secret is deployed (value and permissions not checked)"
      )
    } else if (
      names.has("ARTIFACTS_API_TOKEN") &&
      names.has("AI_GATEWAY_TOKEN")
    ) {
      ok(
        "ARTIFACTS_API_TOKEN and AI_GATEWAY_TOKEN are deployed (values and permissions not checked)"
      )
    } else {
      pending.CLOUDFLARE_RUNTIME_TOKEN = await runtimeToken(account)
    }

    let emails = process.env.ACCESS_ALLOWED_EMAILS
    if (emails) {
      emails = allowedEmails(emails)
      if (!emails)
        throw new SetupError("ACCESS_ALLOWED_EMAILS isn't a list of emails.")
      pending.ACCESS_ALLOWED_EMAILS = emails
      ok(`ACCESS_ALLOWED_EMAILS: ${emails}`)
    } else if (names.has("ACCESS_ALLOWED_EMAILS")) {
      ok("ACCESS_ALLOWED_EMAILS")
    } else {
      note("Who may use this deployment? Everyone listed has full control.")
      while (!emails)
        emails = allowedEmails(
          await ask(
            "Allowed emails, comma-separated:",
            "set ACCESS_ALLOWED_EMAILS",
            who.email
          )
        )
      pending.ACCESS_ALLOWED_EMAILS = emails
      ok(`ACCESS_ALLOWED_EMAILS: ${emails}`)
    }
    return { pending, emails }
  }

  function allowedEmails(value) {
    const emails = value
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean)
    return emails.length &&
      emails.every((email) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email))
      ? emails.join(",")
      : null
  }

  async function deploy(secrets) {
    step("Deploy")
    if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0)
      throw new SetupError(
        "Docker isn't running. Deploying builds the Sandbox images with Docker: start it, then run setup again."
      )
    const args = ["run", "deploy"]
    let directory
    if (Object.keys(secrets).length) {
      // Deploys add these secrets and keep the Worker's others.
      directory = mkdtempSync(join(tmpdir(), "terminus-setup-"))
      const file = join(directory, "secrets.json")
      writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 })
      args.push("--", "--secrets-file", file)
    }
    try {
      const { status, signal } = runInTerminal("npm", args, {
        shell: process.platform === "win32",
      })
      if (signal)
        throw new SetupError(
          "Deploying was interrupted. Run setup again to finish."
        )
      if (status !== 0)
        throw new SetupError(
          "Deploying failed; see Wrangler's output above. Fix it, then run setup again."
        )
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true })
    }
    changed = false
  }

  async function access(account, name, emails) {
    step("Cloudflare Access")
    const vars = localConfig().vars ?? {}
    if (isSet(vars.ACCESS_TEAM_DOMAIN) && isSet(vars.ACCESS_AUD)) {
      if (
        teamOrigin(vars.ACCESS_TEAM_DOMAIN) !== vars.ACCESS_TEAM_DOMAIN ||
        !validAudiences(vars.ACCESS_AUD)
      ) {
        problem(
          `Fix ACCESS_TEAM_DOMAIN (https://<team>.cloudflareaccess.com) and ACCESS_AUD (lowercase 64-character hex tags, comma-separated) in apps/worker/${LOCAL_CONFIG}`
        )
        return
      }
      if (await teamReachable(vars.ACCESS_TEAM_DOMAIN))
        ok(`Team ${vars.ACCESS_TEAM_DOMAIN}`)
      else problem(`${vars.ACCESS_TEAM_DOMAIN} isn't a reachable Access team`)
      return
    }
    if (check) {
      problem("ACCESS_TEAM_DOMAIN and ACCESS_AUD aren't set")
      return
    }
    const url = `https://dash.cloudflare.com/${account}/workers/services/view/${name}/production/settings`
    note("Turn on Cloudflare Access for the Worker:")
    note(`  Workers & Pages → ${name} → Access`)
    note("  → Protect this Worker behind Access → All traffic → Apply Access")
    note(url)
    note(
      `Use an Allow policy for ${emails ?? "the emails in ACCESS_ALLOWED_EMAILS"}.`
    )
    note("In Zero Trust → Access controls → Applications, configure this app.")
    note(
      "Copy its Application Audience (AUD) Tag from Additional settings, and your team domain."
    )
    openInBrowser(url)

    const otherwise = `set ACCESS_TEAM_DOMAIN and ACCESS_AUD in apps/worker/${LOCAL_CONFIG}`
    let team
    while (!team) {
      const answer = await ask(
        "Team domain (your-team.cloudflareaccess.com):",
        otherwise
      )
      const candidate = teamOrigin(answer)
      if (candidate && (await teamReachable(candidate))) team = candidate
      else rejected(`${answer || "That"} isn't a reachable Access team domain.`)
    }
    let aud
    while (!aud) {
      const answer = await ask("Audience (AUD) tag:", otherwise)
      // Tokens carry it in lowercase, and the Worker compares it exactly.
      if (/^[a-f0-9]{64}$/i.test(answer)) aud = answer.toLowerCase()
      else rejected("An AUD tag is 64 hexadecimal characters.")
    }
    await patchLocal({ vars: { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } })
    ok(`Team ${team}`)
  }

  /** Lowercase, as the Worker compares them with the tokens' audience. */
  function validAudiences(value) {
    return (
      typeof value === "string" &&
      value.split(",").every((aud) => /^[a-f0-9]{64}$/.test(aud.trim()))
    )
  }

  function teamOrigin(value) {
    const host = value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
    const full = host.includes(".") ? host : `${host}.cloudflareaccess.com`
    return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(full)
      ? `https://${full}`
      : null
  }

  async function teamReachable(team) {
    try {
      const response = await fetch(`${team}/cdn-cgi/access/certs`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      })
      const body = await response.json()
      return response.ok && Array.isArray(body.keys) && body.keys.length > 0
    } catch {
      return false
    }
  }

  /** A local file or edge redirect does not establish the Worker's actual vars. */
  async function deployedAccess(cf, account, name, origin) {
    step("Deployed Access configuration")
    if (!origin) {
      problem("No app URL to check")
      return null
    }
    const settings = await cf(
      `accounts/${account}/workers/scripts/${name}/settings`
    )
    if (!settings.ok) {
      problem(`Couldn't read deployed Worker settings: ${failure(settings)}`)
      return null
    }
    const vars = Object.fromEntries(
      (settings.result?.bindings ?? [])
        .filter((binding) => binding.type === "plain_text")
        .map((binding) => [binding.name, binding.text])
    )
    const expected = deploymentConfig().vars
    const before = problems
    for (const key of [
      "ACCESS_REQUIRED",
      "APP_ORIGIN",
      "ACCESS_TEAM_DOMAIN",
      "ACCESS_AUD",
    ])
      if (vars[key] !== expected[key])
        problem(
          `Deployed ${key} differs from the local configuration; run setup to deploy it`
        )
    if (vars.ACCESS_REQUIRED !== "true")
      problem("The deployed Worker must have ACCESS_REQUIRED=true")
    if (
      teamOrigin(vars.ACCESS_TEAM_DOMAIN ?? "") !== vars.ACCESS_TEAM_DOMAIN ||
      !validAudiences(vars.ACCESS_AUD)
    )
      problem("The deployed Access team or audience is missing or invalid")
    if (problems !== before) return null
    try {
      if (publicOrigin(vars.APP_ORIGIN) !== origin) {
        problem("The deployed APP_ORIGIN doesn't match the app URL")
        return null
      }
    } catch {
      problem("The deployed APP_ORIGIN isn't a public HTTPS origin")
      return null
    }
    ok(
      "The deployed Worker verifies Access with the configured team and audience"
    )
    return {
      team: vars.ACCESS_TEAM_DOMAIN,
      audiences: vars.ACCESS_AUD.split(",").map((aud) => aud.trim()),
    }
  }

  /** A logged-out request must be sent to Access, never reach the app. */
  async function loggedOutCheck(origin, { team, audiences }) {
    step("Logged-out check")
    if (!origin) {
      problem("No app URL to check")
      return false
    }
    const before = problems
    for (const path of ["/", "/api/networks"]) {
      const url = new URL(path, origin)
      let response
      // A new workers.dev hostname can take a moment to resolve.
      for (let attempt = 1; !response && attempt <= 6; attempt++)
        response = await fetch(url, {
          headers: { accept: "text/html" },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        }).catch(() => (attempt < 6 ? sleep(5_000) : null))
      if (!response) {
        problem(
          `Couldn't reach ${url} yet; run \`npm run setup -- --check\` shortly`
        )
        continue
      }
      const location = response.headers.get("location")
      let toAccess = false
      try {
        const login = new URL(location, url)
        toAccess =
          [301, 302, 303, 307, 308].includes(response.status) &&
          login.origin === team &&
          !login.username &&
          !login.password &&
          /^\/cdn-cgi\/access\/login(?:\/|$)/.test(login.pathname) &&
          (!login.searchParams.has("kid") ||
            audiences.includes(login.searchParams.get("kid")))
      } catch {
        // An invalid Location is not an Access sign-in redirect.
      }
      if (toAccess) {
        ok(`${path} asks for Cloudflare Access sign-in`)
        continue
      }
      const message = await response
        .json()
        .then((body) => body?.error)
        .catch(() => undefined)
      problem(
        `${path} answered ${response.status}${message ? ` (${message})` : ""}: expected an Access sign-in redirect for the configured team and audience`
      )
    }
    return problems === before
  }

  /** The edge and the Worker must both accept an actual allowed user's session. */
  async function signedInCheck(origin) {
    step("Signed-in app check")
    const provided = process.env.TERMINUS_ACCESS_TOKEN?.trim() || undefined
    if (!provided && (check || !process.stdin.isTTY)) {
      problem(
        "Signed-in verification is pending: set TERMINUS_ACCESS_TOKEN to this app's user Access token, then run `npm run setup -- --check`"
      )
      return
    }
    if (!provided) {
      note(`Sign in to ${origin} as an allowed user.`)
      note(
        "In your browser's developer tools → Application/Storage → Cookies, copy CF_Authorization for the app's hostname."
      )
      note(
        "Or use `cloudflared access token --app` for this URL if cloudflared is installed."
      )
      note(
        "The token is sent only to this app, without following redirects. It is never saved or deployed."
      )
      openInBrowser(origin)
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const token =
        provided ??
        (await askSecret(
          "Paste the user Access token (Enter leaves verification pending):",
          "set TERMINUS_ACCESS_TOKEN"
        ))
      if (!token) {
        problem(
          "Signed-in verification is pending; rerun with TERMINUS_ACCESS_TOKEN and --check"
        )
        return
      }
      if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        let response
        try {
          response = await fetch(
            new URL("/api/networks", publicOrigin(origin)),
            {
              headers: {
                cookie: `CF_Authorization=${token}`,
                accept: "application/json",
                "cache-control": "no-cache",
              },
              redirect: "manual",
              signal: AbortSignal.timeout(10_000),
            }
          )
        } catch {
          problem(
            "Couldn't reach the app for signed-in verification; rerun setup with --check"
          )
          return
        }
        const body = await response.json().catch(() => null)
        if (
          response.status === 200 &&
          response.headers.get("content-type")?.includes("application/json") &&
          Array.isArray(body)
        ) {
          ok("An allowed user's session reaches /api/networks successfully")
          return
        }
        rejected(
          `Signed-in /api/networks answered HTTP ${response.status}; check the Access policy, audience, allowed email and database migrations.`
        )
      } else
        rejected(
          "Enter a user Access JWT, not an API token or service-token secret."
        )
      if (provided || attempt === 3) {
        problem(
          "Signed-in verification failed; fix the configuration, then rerun setup with --check"
        )
        return
      }
    }
  }

  async function localDevelopment(account) {
    step("Local development")
    const devVars = workerPath(".dev.vars")
    // It may be a secrets manager's named pipe or link, so it is never read,
    // followed or replaced. lstat also counts a link whose target is missing.
    if (lstatSync(devVars, { throwIfNoEntry: false })) {
      ok("apps/worker/.dev.vars exists (left unchanged)")
      note(
        "It holds CLOUDFLARE_RUNTIME_TOKEN (or the older pair); see .dev.vars.example."
      )
      return
    }
    if (check) {
      problem("No apps/worker/.dev.vars")
      return
    }
    const token = await runtimeToken(account)
    writeFileSync(devVars, `CLOUDFLARE_RUNTIME_TOKEN=${token}\n`, {
      mode: 0o600,
      flag: "wx",
    })
    ok("Wrote apps/worker/.dev.vars")
  }

  async function main() {
    console.log(
      check
        ? "Checking Terminus's setup. Nothing will change."
        : local
          ? "Setting up Terminus for local development."
          : "Setting up Terminus in your Cloudflare account."
    )
    if (Number(process.versions.node.split(".")[0]) < 24)
      throw new SetupError(
        `Terminus needs Node 24; this is ${process.version}.`
      )

    const { who, cf } = await signIn()
    const account = await chooseAccount(who)

    if (local) {
      await localDevelopment(account)
      finish(
        "Start Docker, then run `npm run dev:worker` and `npm run dev:web`."
      )
      return
    }

    const name = deploymentConfig().name
    if (deploymentConfig().vars?.ACCESS_REQUIRED !== "true")
      throw new SetupError("Live setup requires ACCESS_REQUIRED=true.")
    let origin = await appOrigin(cf, account, name)
    await resources(cf, account, deploymentConfig())
    const secrets = await workerSecrets(cf, account, name, who)
    // Always apply migrations and deploy. A local edit survives process failure,
    // but the old in-memory `changed` flag did not; Worker existence proves neither.
    if (!check) {
      await deploy(secrets.pending)
      origin ??= await appOrigin(cf, account, name)
    }
    await access(account, name, secrets.emails)
    if (!check && changed) await deploy({})
    if (!problems) {
      const deployed = await deployedAccess(cf, account, name, origin)
      if (deployed && (await loggedOutCheck(origin, deployed)))
        await signedInCheck(origin)
    }

    finish(
      `Terminus is live at ${origin}\nSign in, then choose Create network: the demo app is filled in.`
    )
  }

  /** Summarizes a check, or prints `success` after a run without problems. */
  function finish(success) {
    if (check)
      console.log(
        problems
          ? `\n${problems} thing${problems === 1 ? "" : "s"} to set up: run \`${rerun}\`.`
          : "\nEverything is set up."
      )
    else if (!problems) console.log(`\n${success}`)
  }

  try {
    await main()
  } catch (error) {
    if (!(error instanceof SetupError)) throw error
    console.error(`\n${error.message}`)
    problems ||= 1
  } finally {
    reader?.close()
  }
  return problems ? 1 : 0
}

// Not `import.meta.main`, which needs Node 22.18 or 24.2: older Node must still
// run setup to report its version, not exit silently.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await setup()
