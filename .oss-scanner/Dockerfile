# Build image for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository as context, then audits the image with
# no network, so every dependency the build and tests need is fetched here.
# Scope: TypeScript packages, sync server, CLI, desktop main/preload sources, and the
# Rust core. iOS, landing, docs, and Electron packaging are not built on Linux.
FROM debian:bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential clang pkg-config python3 unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node and pnpm versions match .nvmrc and package.json#packageManager.
ARG NODE_VERSION=24.21.0
RUN arch="$(dpkg --print-architecture | sed 's/amd64/x64/')" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
       | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g corepack@latest && corepack enable

# Rust toolchain matches crates/rust-toolchain.toml; rustup installs its pinned components on first use.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.98.1 \
    && rustup component add clippy rustfmt

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src
# Electron is not launched in the image; the Node-target native prebuilds are enough for tests.
ENV CI=true HUSKY=0 SKIP_ELECTRON_REBUILD=1

RUN corepack install && pnpm install --frozen-lockfile

# Rust core: fetch every crate now so cargo works offline later, then build with debug info.
RUN cd crates && cargo fetch --locked \
    && cargo build --locked -p memry-core -p memry-cli --all-targets
ENV CARGO_NET_OFFLINE=true

# Cheap tests so the image is known to work; failures do not abort the build.
RUN cd crates && (cargo test --locked -p memry-core || echo "WARNING: cargo test reported failures")
RUN (pnpm test:sync-server || echo "WARNING: sync-server tests reported failures")
RUN (pnpm test:cli || echo "WARNING: cli tests reported failures")
