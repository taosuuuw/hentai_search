#!/bin/bash
# =============================================================================
# hentai搜索 —— macOS 双击入口（Finder 里双击这个文件即可）
# =============================================================================
# 真正干活的逻辑全在同目录的 start-engine.sh 里，这里只做转发，保持极短。
#
# 首次使用（只需一次）——在项目根目录执行：
#     chmod +x start-engine.sh start-engine.command
# 双击没反应、或报 "Permission denied"，多半就是漏了这一步。
#
# 也可以在终端里带参数用：
#     ./start-engine.command --status
#     ./start-engine.command --stop
#     ./start-engine.command --port 8899
# =============================================================================
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -x "$DIR/start-engine.sh" ]; then
  echo "[hentai-search] 提示：start-engine.sh 还没有可执行权限，先用 bash 跑一遍。"
  echo "[hentai-search] 建议执行：chmod +x \"$DIR/start-engine.sh\" \"$DIR/start-engine.command\""
  exec bash "$DIR/start-engine.sh" "$@"
fi

exec "$DIR/start-engine.sh" "$@"
