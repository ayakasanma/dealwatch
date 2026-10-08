#!/usr/bin/env bash
# 給排程器用：程序不在就重啟並輸出 RESTARTED；最近被擋輸出 BLOCKED；否則輸出 OK。
cd "$(dirname "$0")/.." || exit 1

if ! { [ -f data/watch.pid ] && kill -0 "$(cat data/watch.pid)" 2>/dev/null; }; then
  nohup bash cloud/start.sh >/dev/null 2>&1 &
  echo "RESTARTED dealwatch 沒在執行，已重新啟動"
  exit 0
fi

if tail -n 20 data/watch.log 2>/dev/null | grep -q '查詢失敗'; then
  echo "BLOCKED $(tail -n 20 data/watch.log | grep '查詢失敗' | tail -n 1)"
  exit 0
fi

echo "OK"
