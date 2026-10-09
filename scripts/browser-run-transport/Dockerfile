FROM node:24-trixie-slim
WORKDIR /opt/proof
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY client.mjs app.mjs ./
EXPOSE 3000
CMD ["sleep", "infinity"]
