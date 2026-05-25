#!/bin/bash

# 查找并杀死占用 5174 (前端)、8787 (Gemini Bridge) 和 8790 (Video Bridge) 端口的进程
echo "Stopping existing services on ports 5174, 8787 and 8790..."
PIDS=$(lsof -t -i:5174 -i:8787 -i:8790)
if [ ! -z "$PIDS" ]; then
  kill -9 $PIDS
  echo "Killed processes: $PIDS"
else
  echo "No existing processes found on ports 5174, 8787 or 8790."
fi

# 重新启动服务
echo "Starting services..."
npm run dev:all
