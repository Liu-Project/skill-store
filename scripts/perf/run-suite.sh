#!/usr/bin/env bash
# 压测套件：生成数据 -> 启动服务 -> 跑多场景 -> 汇总结果
#
# 用法:
#   bash scripts/perf/run-suite.sh --tag baseline [--server local-registry/server.js] [--count 5000] [--zip-size 8192]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAG="baseline"
SERVER="$ROOT/local-registry/server.js"
COUNT=5000
ZIP_SIZE=8192
PORT=4010
RESULTS_DIR="$ROOT/scripts/perf/results"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2;;
    --server) SERVER="$2"; shift 2;;
    --count) COUNT="$2"; shift 2;;
    --zip-size) ZIP_SIZE="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    *) echo "未知参数: $1"; exit 1;;
  esac
done

DATA_DIR="/tmp/perf-reg-$TAG"

mkdir -p "$RESULTS_DIR"
echo "==> 生成合成数据 ($COUNT 技能) 到 $DATA_DIR"
rm -rf "$DATA_DIR"
node "$ROOT/scripts/perf/gen-index.js" --dir "$DATA_DIR" --count "$COUNT" --zip-size "$ZIP_SIZE" >/dev/null

echo "==> 启动服务: $SERVER 于端口 $PORT"
node "$SERVER" --port "$PORT" --host 127.0.0.1 --dir "$DATA_DIR" >"$RESULTS_DIR/$TAG.server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for i in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/api/v1/whoami" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

run() {
  local mode="$1" conc="$2" dur="$3" extra="${4:-}"
  local out
  out=$(node "$ROOT/scripts/perf/loadtest.js" \
    --url "http://127.0.0.1:$PORT" --mode "$mode" \
    --concurrency "$conc" --duration "$dur" --pid "$SERVER_PID" $extra)
  echo "$out"
  echo "$out" >>"$RESULTS_DIR/$TAG.raw.jsonl"
}

echo "==> 开始压测（结果写入 $RESULTS_DIR/$TAG.raw.jsonl）"
: >"$RESULTS_DIR/$TAG.raw.jsonl"

run search 1 10
run search 10 10
run search 50 15
run search 100 15
run searchAll 100 10
run categories 100 10
run resolve 100 10
run mixed 100 15
run download 50 10
run download 100 10
run search 100 10 "--gzip"
run search 100 10 "--etag"

echo "==> 服务进程 CPU/RSS 快照"
ps -o pid,%cpu,rss,etime,cmd -p "$SERVER_PID" | head -2 || true

kill "$SERVER_PID" 2>/dev/null || true
trap - EXIT

echo "==> 完成: $RESULTS_DIR/$TAG.raw.jsonl"
