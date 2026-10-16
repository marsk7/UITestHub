#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  umask 077
  cp .env.example .env
  echo '已创建 .env。请先编辑 ADMIN_PASSWORD、DB_PASSWORD、MYSQL_ROOT_PASSWORD，再执行 bash start.sh。'
  exit 1
fi
if grep -Eq 'CHANGE_ME|replace-with-at-least' .env; then
  echo '请先修改 .env 中的占位密码，再构建。'; exit 1
fi
command -v docker >/dev/null || { echo '请启动 Docker Desktop 或安装 Docker Engine。'; exit 1; }
docker compose version >/dev/null
docker compose config --quiet
docker compose build api
docker compose up -d --force-recreate
echo '已提交启动。检查 docker compose ps 和 docker compose logs --tail=100 api worker mysql。'
echo '默认访问 http://127.0.0.1:8080；首次初始化账号 admin，密码为 .env 中 ADMIN_PASSWORD；已有账号密码以数据库为准。'
