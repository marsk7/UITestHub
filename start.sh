#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo '请先安装 Docker 和 Docker Compose 插件。'; exit 1; }
docker compose version >/dev/null
if [ ! -f .env ]; then
  umask 077
  if command -v openssl >/dev/null; then
    testhub_password="$(openssl rand -hex 24)"
  elif command -v python3 >/dev/null; then
    testhub_password="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
  else
    echo '需要 openssl 或 python3 生成初始密码。'; exit 1
  fi
  cat > .env <<ENV
ADMIN_PASSWORD=${testhub_password}
PORT=8080
LLM_BASE_URL=
LLM_MODEL=
LLM_API_KEY=
COOKIE_SECURE=false
ENV
  echo "初始管理员密码：${testhub_password}"
  echo '密码已保存到 .env，请妥善保管。'
fi
docker compose up -d --build
echo '平台启动后访问 http://127.0.0.1:8080 （修改 PORT 后请使用对应端口）。'
echo '服务器远程访问请使用 SSH 端口转发或配置 HTTPS 反向代理。'
