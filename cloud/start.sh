#!/usr/bin/env bash
# 常駐執行 dealwatch，當掉 30 秒後自動重啟。輸出寫到 data/watch.log。
# 用法: nohup bash cloud/start.sh >/dev/null 2>&1 &
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
echo $$ > data/watch.pid

while true; do
  node dealwatch.mjs watch --headless >> data/watch.log 2>&1
  echo "$(date -Is) dealwatch 結束 (exit $?)，30 秒後重啟" >> data/watch.log
  sleep 30
done
