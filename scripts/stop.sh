#!/usr/bin/env bash
# Останавливает фоновый сервер.
pkill -f "node server.js" 2>/dev/null || true
echo "stopped"