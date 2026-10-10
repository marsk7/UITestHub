#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
testhub_test_db="testhub_test_$(date +%s)_${RANDOM}"
cleanup() {
  docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "DROP DATABASE IF EXISTS $1"' sh "$testhub_test_db" >/dev/null || true
}
trap cleanup EXIT
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "CREATE DATABASE $1 CHARACTER SET utf8mb4; GRANT ALL ON $1.* TO '\''$MYSQL_USER'\''@'\''%'\'';"' sh "$testhub_test_db"
docker compose -f compose.yaml -f compose.dev.yaml run --rm --no-deps \
  -e DB_NAME="$testhub_test_db" -e RUN_BROWSER_TESTS="${RUN_BROWSER_TESTS:-0}" api npm test
