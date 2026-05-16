#!/bin/bash

# 查找并杀死占用 5174 (前端) 和 8787 (后端) 端口的进程
echo "Stopping existing services on ports 5174 and 8787..."
PIDS=$(lsof -t -i:5174 -i:8787)
if [ ! -z "$PIDS" ]; then
  kill -9 $PIDS
  echo "Killed processes: $PIDS"
else
  echo "No existing processes found on ports 5174 or 8787."
fi

# 重新启动服务
echo "Starting services..."
npm run dev:all
