#!/usr/bin/env bash
# 专项测试：稳定性（2min 混合负载） + 发布期间读请求退化
# 用法: bash scripts/perf/run-extra.sh [--tag optimized] [--server ...]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAG="optimized"
SERVER="$ROOT/local-registry/server.js"
PORT=4020
DATA_DIR="/tmp/perf-extra-$TAG"
RESULTS_DIR="$ROOT/scripts/perf/results"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2;;
    --server) SERVER="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    *) echo "未知参数: $1"; exit 1;;
  esac
done

mkdir -p "$RESULTS_DIR"
rm -rf "$DATA_DIR"
node "$ROOT/scripts/perf/gen-index.js" --dir "$DATA_DIR" --count 5000 --zip-size 8192 >/dev/null

node "$SERVER" --port "$PORT" --host 127.0.0.1 --dir "$DATA_DIR" >"$RESULTS_DIR/$TAG.extra-server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
for i in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/api/v1/whoami" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "==> S6 稳定性：mixed c=100 持续 120s（观察 RSS 曲线）"
node "$ROOT/scripts/perf/loadtest.js" --url "http://127.0.0.1:$PORT" --mode mixed --concurrency 100 --duration 120 --pid "$SERVER_PID" \
  | tee "$RESULTS_DIR/$TAG.stability.json"

echo "==> S4 发布+读混合：mixed c=100 持续 45s，第 8s 发布 3MB 包"
# 构造 3MB 技能包（放 /tmp，避免污染仓库）
PKG_DIR="/tmp/_perf-pub-src"
rm -rf "$PKG_DIR"; mkdir -p "$PKG_DIR/scripts"
printf -- '---\nname: perf-pub\ndescription: 发布阻塞测试包\nauthor: "Perf"\n---\n# perf-pub\n' > "$PKG_DIR/SKILL.md"
node -e "
const fs=require('fs'); const b=require('crypto').randomBytes(3*1024*1024);
fs.writeFileSync(process.argv[1]+'/scripts/payload.bin', b);
" "$PKG_DIR"
node -e "
const AdmZip=require(process.argv[1]+'/node_modules/adm-zip');
const zip=new AdmZip(); zip.addLocalFolder(process.argv[2]);
const buf=zip.toBuffer();
const http=require('http');
const boundary='----skillstore'+Date.now().toString(16);
const chunks=[];
chunks.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name=\"namespace\"\r\n\r\nglobal\r\n'));
chunks.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name=\"version\"\r\n\r\n1.0.0\r\n'));
chunks.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name=\"skill\"; filename=\"perf-pub.zip\"\r\nContent-Type: application/zip\r\n\r\n'));
chunks.push(buf); chunks.push(Buffer.from('\r\n--'+boundary+'--\r\n'));
const body=Buffer.concat(chunks);
console.error('[发布测试] zip 大小:', buf.length);
const start=Date.now();
const req=http.request({host:'127.0.0.1',port:process.argv[3],path:'/api/v1/publish',method:'POST',
  headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':body.length}},
  res=>{let d=[];res.on('data',c=>d.push(c));res.on('end',()=>{
    const ms=Date.now()-start;
    console.error('[发布测试] HTTP '+res.statusCode+' 耗时 '+ms+'ms body='+Buffer.concat(d).toString().slice(0,120));
  });});
req.end(body);
" "$ROOT" "$PKG_DIR" "$PORT" &
PUB_PID=$!
sleep 8

node "$ROOT/scripts/perf/loadtest.js" --url "http://127.0.0.1:$PORT" --mode mixed --concurrency 100 --duration 45 --pid "$SERVER_PID" \
  | tee "$RESULTS_DIR/$TAG.publish-mixed.json"
wait $PUB_PID

kill "$SERVER_PID" 2>/dev/null || true
trap - EXIT
echo "==> 完成"
