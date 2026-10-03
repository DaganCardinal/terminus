FROM node:24-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --ignore-scripts opencode-linux-x64-baseline@1.18.32 \
    && ln -s /usr/local/lib/node_modules/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace
# Wrangler's local container runner requires an exposed port, even for exec-only images.
# This is metadata only; the Sandbox uses the Container command API, not an HTTP server.
EXPOSE 8080
CMD ["sleep", "infinity"]
