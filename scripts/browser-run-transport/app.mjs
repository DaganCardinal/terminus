import { createServer } from "node:http"

let requests = 0
createServer((request, response) => {
  requests++
  if (request.url === "/state") {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ requests, scope: process.env.PROBE_SCOPE }))
    return
  }
  response.setHeader("content-type", "text/html")
  response.end(`<!doctype html><html><body>
    <button onclick="this.textContent='Clicked'">Click me</button>
  </body></html>`)
}).listen(3000, "0.0.0.0")
