# Image for running vaultsync on a server (e.g. a Docker host that mounts your NAS).
# Settings come from compose.yml; see compose.example.yml.

# Small Node.js base image, plus git (vaultsync drives the git command-line tool).
FROM node:22-alpine
RUN apk add --no-cache git \
 # The vault folders on the NAS belong to a NAS user, not to the user the container runs as.
 # Git refuses to work in folders owned by someone else ("dubious ownership") unless told to trust them.
 && git config --system safe.directory '*'

WORKDIR /app

# Install dependencies first, so Docker can reuse this layer when only the code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin ./bin
COPY src ./src
# Template that `vaultsync init` copies into each vault's .gitignore.
COPY vault.gitignore ./

# `docker compose run --rm vaultsync <command>` runs that command; without one it runs `watch`.
ENTRYPOINT ["node", "/app/bin/vaultsync.js"]
CMD ["watch"]
