FROM node:24-bookworm-slim

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN printf '%s\n' \
      'Types: deb' \
      'URIs: http://mirrors.tuna.tsinghua.edu.cn/debian' \
      'Suites: bookworm bookworm-updates' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      '' \
      'Types: deb' \
      'URIs: http://mirrors.tuna.tsinghua.edu.cn/debian-security' \
      'Suites: bookworm-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      > /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      'Acquire::Retries "3";' \
      'Acquire::http::Timeout "60";' \
      'Acquire::https::Timeout "60";' \
      'APT::Update::Error-Mode "any";' \
      > /etc/apt/apt.conf.d/80-retries \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates

# CA 证书安装完成后恢复 HTTPS，并验证索引下载
RUN sed -i \
      's|http://mirrors.tuna.tsinghua.edu.cn|https://mirrors.tuna.tsinghua.edu.cn|g' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

RUN npx playwright install-deps chromium

RUN npx playwright install chromium

RUN apt-get update \
    && apt-get install -y --no-install-recommends zip fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node checks ./checks

RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 8080

CMD ["node","src/server.mjs"]
