// The Browser Run proof's candidate application. It runs inside the Sandbox
// on the fixed application port, and the remote browser reaches it only
// through the Sandbox's private candidate route.
import { createServer } from "node:http"

let requests = 0
createServer((request, response) => {
  requests++
  if (request.url === "/state") {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ requests, scope: process.env.PROOF_SCOPE }))
    return
  }
  response.setHeader("content-type", "text/html")
  response.end(`<!doctype html><html><body>
    <button onclick="this.textContent='Clicked'">Click me</button>
  </body></html>`)
}).listen(3000, "0.0.0.0")
