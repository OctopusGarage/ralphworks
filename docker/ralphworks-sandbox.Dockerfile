FROM node:24-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN mkdir -p "$PNPM_HOME"

WORKDIR /opt/ralphworks
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY tsconfig.build.json ./
COPY src ./src
RUN pnpm install --frozen-lockfile && pnpm build && pnpm link --global \
  && ln -sf "$PNPM_HOME/ralphworks" /usr/local/bin/ralphworks \
  && ln -sf "$PNPM_HOME/ralph" /usr/local/bin/ralph

RUN usermod -d /home/agent -m -l agent node
USER agent

WORKDIR /home/agent

ENTRYPOINT ["sleep", "infinity"]
