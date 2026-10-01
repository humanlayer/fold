# The Computer's Linux container: computerd, which mounts the session's workspace at /workspace and runs
# the agent's container commands, plus git, node, bun and python for installs, builds and tests.
#
# Based on @cloudflare/computer's examples/container. computerd comes from a fork of cloudflare/computer
# that keeps gitignored files in the container (SYNC_GITIGNORE below), so installs and builds never reach
# the Computer's storage. See https://github.com/cloudflare/computer/issues/179. To change it, push to
# the fork and update COMPUTER_COMMIT.

FROM node:22-bookworm AS computerd
ARG COMPUTER_REPO=https://github.com/K-Mistele/computer
ARG COMPUTER_COMMIT=b8aa33f8d770dc3ab0c3f1156390a15c9f2d45da
RUN git clone --filter=blob:none "$COMPUTER_REPO" /opt/computer \
 && cd /opt/computer \
 && git checkout "$COMPUTER_COMMIT" \
 && npm ci \
 && npm run build --workspace @cloudflare/dofs --workspace @cloudflare/computer-rpc --workspace @cloudflare/computerd

FROM oven/bun:1.3.14-debian AS bun

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git jq ripgrep python3 tmux fd-find \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

COPY --from=computerd /opt/computer /opt/computer

# computerd serves HTTP on PORT and mounts the workspace at MOUNT_POINT. FUSE_MOUNT=auto uses the kernel's
# FUSE, which Cloudflare Containers provide, and falls back to a userspace copy where it is missing.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
# Run the agent's commands as root in a bash login shell, like a terminal: computerd calls
# `$EXEC_SHELL -c <command>`, and the wrapper adds -l so /etc/profile and ~/.bashrc load.
ENV HOME=/root
ENV SHELL=/bin/bash
ENV EXEC_SHELL=/usr/local/bin/agent-bash
RUN printf '#!/bin/bash\nexec /bin/bash -l "$@"\n' > /usr/local/bin/agent-bash \
 && chmod +x /usr/local/bin/agent-bash
# Keep computerd's copy of the workspace on disk, not in memory, so a large install can't fill the
# container's memory. Skip SQLite's disk syncs: the disk goes away with the container, so a crash can't
# leave a damaged store behind, and syncing was most of the cost of saving each file.
ENV COMPUTERD_DB=/var/lib/computerd/state.db
ENV COMPUTERD_DB_SYNCHRONOUS=off
# Let the kernel remember "file not found" for a second. Module resolution looks for many files that
# don't exist, and without this every miss goes to computerd. computerd waits out the second after the
# Computer sends files, so a command never misses one.
ENV COMPUTERD_FUSE_NEGATIVE_TIMEOUT=1
# Never send gitignored files back to the Computer.
ENV SYNC_GITIGNORE=1
RUN mkdir -p /var/lib/computerd
EXPOSE 8080

ENTRYPOINT ["node", "/opt/computer/packages/computerd/dist/cli/computerd.cjs"]
