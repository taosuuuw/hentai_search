#!/usr/bin/env bash
# =============================================================================
# hentai搜索 —— 本地引擎（网关）一键启动器 · macOS / Linux 版
# =============================================================================
# 行为与 Windows 版（start-engine.cmd + tools/start-gateway.ps1）对齐：
#   1 定位到脚本自己所在目录（= 项目根）并 cd 进去
#   2 检查 node 是否存在（建议 >= 18）并打印版本
#   3 找出占用端口的进程：只杀进程名是 node 的，别的进程一律不碰
#   4 起引擎：node tools/gateway.js --port <PORT>（默认 8788）
#   5 轮询 http://127.0.0.1:<PORT>/api/ping 直到就绪（最多 30 次 × 0.9s）
#   6 自检：ping 的 sources 里有没有 pixiv；再打一遍 /api/reader（nhentai / mangadex）
#   7 打开浏览器（macOS: open；Linux: xdg-open）
#
# 用法：
#   ./start-engine.sh [--port 8788] [--stop] [--status] [--no-browser]
#                     [--foreground] [--keep-open] [-- <gateway.js 的参数…>]
#
# 退出码（与 Windows 版一致）：
#   0 = 引擎已就绪，启动器可以退出
#   2 = 正常收尾但保留输出（--status / --stop / --keep-open）
#   1 = 失败
#
# 兼容性：只用 bash 3.2 也支持的特性 —— macOS 自带的就是 bash 3.2。
# 所以这里刻意**没有**：关联数组（declare -A）、mapfile / readarray、
# ${var,,} / ${var^^}、`local -n`、`&>>` 这些 bash 4+ 写法；
# 也刻意不在 `set -u` 下展开空数组（bash 3.2 里 "${arr[@]}" 会报 unbound variable），
# 而是用计数变量 EXTRA_N 守住。
# =============================================================================
set -euo pipefail

PORT=8788
DO_STOP=0
DO_STATUS=0
NO_BROWSER=0
FOREGROUND=0
KEEP_OPEN=0
EXTRA_N=0        # `--` 之后要透传给 gateway.js 的参数个数（不用 ${#EXTRA[@]}，见文件头）
EXTRA=()         # 同上：只在 EXTRA_N > 0 时才展开

UNAME_S="$(uname -s 2>/dev/null || printf 'unknown')"

# 只在真终端里上色；重定向到文件 / CI 里就是纯文本
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_CYAN=$'\033[36m'
  C_GRAY=$'\033[90m'
  C_OFF=$'\033[0m'
else
  C_RED=''
  C_GREEN=''
  C_YELLOW=''
  C_CYAN=''
  C_GRAY=''
  C_OFF=''
fi

say() {
  # say "消息" [颜色]
  local color="${2:-}"
  if [ -n "$color" ]; then
    printf '%s%s%s\n' "$color" "$1" "$C_OFF"
  else
    printf '%s\n' "$1"
  fi
}

usage() {
  cat <<'EOF'
hentai搜索 本地引擎一键启动器（macOS / Linux）

用法：
  ./start-engine.sh [选项] [-- <gateway.js 的参数…>]

选项：
  --port N        端口，默认 8788
  --status        只看状态（只读：不动任何进程，也不起引擎）
  --stop          只停掉占用该端口的 node 引擎，不启动
  --no-browser    启动后不自动打开浏览器
  --foreground    不后台运行，直接在当前终端跑引擎（日志就在眼前，Ctrl+C 停止）
  --keep-open     引擎就绪后保留输出（退出码 2）
  -h, --help      显示这段帮助

示例：
  ./start-engine.sh
  ./start-engine.sh --status
  ./start-engine.sh --stop
  ./start-engine.sh --port 8899 --no-browser
  ./start-engine.sh -- --proxy http://127.0.0.1:7897

退出码：0 = 引擎已就绪 / 2 = 正常收尾但保留输出（--status、--stop、--keep-open）/ 1 = 失败
EOF
}

# -----------------------------------------------------------------------------
# HTTP / JSON 小工具（不依赖 jq：JSON 解析一律走 node）
# -----------------------------------------------------------------------------
http_get() {
  # $1 = url，$2 = 超时秒数。失败就回空字符串，绝不把非零状态带出去。
  local url="$1"
  local t="${2:-5}"
  if [ "$HAVE_CURL" = "1" ]; then
    curl -sS --max-time "$t" "$url" 2>/dev/null || true
  else
    node -e '
      var http = require("http");
      var url = process.argv[1];
      var ms = (parseInt(process.argv[2] || "5", 10) || 5) * 1000;
      var req = http.get(url, function (res) {
        var s = "";
        res.setEncoding("utf8");
        res.on("data", function (d) { s += d; });
        res.on("end", function () { process.stdout.write(s); });
      });
      req.setTimeout(ms, function () { req.destroy(); });
      req.on("error", function () {});
    ' "$url" "$t" 2>/dev/null || true
  fi
  return 0
}

json_field() {
  # $1 = JSON 文本，$2 = 字段名（version / egress / sources / has_pixiv）
  printf '%s' "$1" | node -e '
    var s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function (d) { s += d; });
    process.stdin.on("end", function () {
      var j = null;
      try { j = JSON.parse(s); } catch (e) { j = null; }
      var k = process.argv[1] || "";
      if (!j) { process.stdout.write(""); return; }
      if (k === "has_pixiv") {
        var src = Array.isArray(j.sources) ? j.sources : [];
        process.stdout.write(src.indexOf("pixiv") >= 0 ? "1" : "0");
        return;
      }
      if (k === "sources") {
        process.stdout.write(Array.isArray(j.sources) ? j.sources.join(", ") : "");
        return;
      }
      var v = j[k];
      process.stdout.write((v === undefined || v === null) ? "" : String(v));
    });
  ' "$2" 2>/dev/null || true
  return 0
}

reader_probe() {
  # $1 = source，$2 = id，$3 = 超时秒数
  # 输出一行：状态<TAB>页数<TAB>话数<TAB>错误原因（拿不到就什么都不输出）
  local src="$1"
  local id="$2"
  local t="${3:-45}"
  local body
  body="$(http_get "http://127.0.0.1:$PORT/api/reader?source=$src&id=$id" "$t")"
  if [ -z "$body" ]; then
    return 0
  fi
  printf '%s' "$body" | node -e '
    var s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function (d) { s += d; });
    process.stdin.on("end", function () {
      var T = "\t";
      var j = null;
      try { j = JSON.parse(s); } catch (e) { j = null; }
      if (!j) { process.stdout.write("PARSE_ERROR" + T + "0" + T + "0" + T + "\n"); return; }
      var pages = Array.isArray(j.pages) ? j.pages.length : 0;
      var chaps = Array.isArray(j.chapters) ? j.chapters.length : 0;
      var err = j.error ? String(j.error) : "";
      err = err.replace(/[\r\n\t]+/g, " ");
      process.stdout.write((j.ok ? "OK" : "FAIL") + T + pages + T + chaps + T + err + "\n");
    });
  ' 2>/dev/null || true
  return 0
}

RS_STATUS=''
RS_PAGES='0'
RS_CHAPS='0'
RS_ERR=''
reader_split() {
  # $1 = reader_probe 的输出；结果写进 RS_* 全局变量（bash 3.2 下最省事的做法）
  local raw="$1"
  local tab rest
  RS_STATUS=''
  RS_PAGES='0'
  RS_CHAPS='0'
  RS_ERR=''
  if [ -z "$raw" ]; then
    return 0
  fi
  tab="$(printf '\t')"
  RS_STATUS="${raw%%"$tab"*}"
  rest="${raw#*"$tab"}"
  RS_PAGES="${rest%%"$tab"*}"
  rest="${rest#*"$tab"}"
  RS_CHAPS="${rest%%"$tab"*}"
  RS_ERR="${rest#*"$tab"}"
  return 0
}

check_reader() {
  # $1 = source，$2 = id，$3 = 显示名。按 Windows 版的格式打印一行结论
  local src="$1"
  local id="$2"
  local label="$3"
  local raw extra
  raw="$(reader_probe "$src" "$id" 45)"
  reader_split "$raw"
  if [ "$RS_STATUS" = "OK" ]; then
    extra=''
    if [ "$RS_CHAPS" -gt 0 ]; then
      extra=" / $RS_CHAPS 话"
    fi
    say "  [OK] $label：$RS_PAGES 页$extra" "$C_GREEN"
  elif [ "$RS_STATUS" = "FAIL" ]; then
    say "  [--] $label：$RS_ERR" "$C_YELLOW"
  else
    say "  [--] $label：接口无响应（网关可能还在跑上游请求，稍后 ./start-engine.sh --status 再看）" "$C_YELLOW"
  fi
  return 0
}

# -----------------------------------------------------------------------------
# 端口占用者：只认进程名是 node 的
# -----------------------------------------------------------------------------
listener_pids() {
  # $1 = 端口；每行打印一个 PID，找不到就什么都不打印
  local p="$1"
  local pids=""
  if [ "$UNAME_S" = "Darwin" ]; then
    # macOS：lsof
    pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)"
  else
    # Linux：优先 ss -lptn，没有再退 lsof
    if command -v ss >/dev/null 2>&1; then
      pids="$(ss -lptn "sport = :$p" 2>/dev/null | grep -o 'pid=[0-9][0-9]*' | cut -d= -f2 || true)"
    fi
    if [ -z "$pids" ] && command -v lsof >/dev/null 2>&1; then
      pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)"
    fi
  fi
  printf '%s\n' "$pids" | tr -d '\r' | grep -E '^[0-9]+$' | sort -u || true
  return 0
}

proc_name() {
  # $1 = PID；打印进程名（取 basename，去掉空白与 CR），读不到就打印空
  local raw
  raw="$(ps -p "$1" -o comm= 2>/dev/null || true)"
  raw="${raw##*/}"
  printf '%s' "$raw" | tr -d '[:space:]' | tr -d '\r' || true
  return 0
}

stop_engine() {
  # $1 = 端口。全部占用者都是 node -> 停干净并返回 0；
  # 只要有一个不是 node、或读不出进程名 -> 一个都不动，返回 1（绝不动别人的进程）
  local p="$1"
  local pids pid name victims
  victims=""
  pids="$(listener_pids "$p")"
  if [ -z "$pids" ]; then
    say "端口 $p 上没有监听进程（引擎本来就没在跑）" "$C_GRAY"
    return 0
  fi
  for pid in $pids; do
    name="$(proc_name "$pid")"
    if [ -z "$name" ]; then
      if kill -0 "$pid" 2>/dev/null; then
        say "警告：端口 $p 被 PID=$pid 占用，但读不到它的进程名（可能是别人的进程）。我不动它，请自行处理。" "$C_YELLOW"
        return 1
      fi
      say "端口 $p 的持有者 PID=$pid 已不存在" "$C_GRAY"
      continue
    fi
    if [ "$name" != "node" ]; then
      say "警告：端口 $p 被 PID=$pid（$name）占用，那不是本引擎，我不动它，请自行处理。" "$C_YELLOW"
      return 1
    fi
    victims="$victims $pid"
  done
  if [ -z "$victims" ]; then
    return 0
  fi
  for pid in $victims; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $victims; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
  for pid in $victims; do
    say "已停掉旧引擎（PID=$pid）" "$C_GREEN"
  done
  return 0
}

# -----------------------------------------------------------------------------
# 状态 / 浏览器
# -----------------------------------------------------------------------------
show_status() {
  # $1 = 端口。只读：不发停止请求、不 kill、不起进程
  local p="$1"
  local body raw
  body="$(http_get "http://127.0.0.1:$p/api/ping" 5)"
  if [ -z "$body" ]; then
    say "引擎：未运行（端口 $p 无响应）" "$C_YELLOW"
    return 0
  fi
  if [ "$HAVE_NODE" != "1" ]; then
    say "引擎：端口 $p 有响应，但本机没有 node，解析不了 JSON —— 原文如下：" "$C_YELLOW"
    printf '%s\n' "$body" | head -c 400 || true
    printf '\n'
    return 0
  fi
  say "引擎：运行中  version=$(json_field "$body" version)  出口=$(json_field "$body" egress)" "$C_GREEN"
  say "  sources: $(json_field "$body" sources)" "$C_GRAY"
  if [ "$(json_field "$body" has_pixiv)" = "1" ]; then
    say '  版本：新版本（含 pixiv / nhentai / 在线阅读路由）' "$C_GREEN"
  else
    say '  版本：旧进程（没有 pixiv，也就没有 /api/reader）→ 需要重启' "$C_RED"
  fi
  raw="$(reader_probe nhentai 682396 30)"
  if [ -z "$raw" ]; then
    say '  在线阅读测试：接口无响应' "$C_RED"
    return 0
  fi
  reader_split "$raw"
  if [ "$RS_STATUS" = "OK" ]; then
    say "  在线阅读测试：nhentai ok=true pages=$RS_PAGES" "$C_GREEN"
  elif [ "$RS_STATUS" = "FAIL" ]; then
    say "  在线阅读测试：nhentai ok=false pages=$RS_PAGES  （$RS_ERR）" "$C_RED"
  else
    say '  在线阅读测试：接口无响应' "$C_RED"
  fi
  return 0
}

open_browser() {
  # $1 = url
  local url="$1"
  case "$UNAME_S" in
    Darwin)
      if command -v open >/dev/null 2>&1; then
        if open "$url" >/dev/null 2>&1; then
          say '已打开浏览器。' "$C_GREEN"
          return 0
        fi
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      # 顺带照顾在 Git Bash / Cygwin 里跑这个脚本的人
      if command -v cmd.exe >/dev/null 2>&1; then
        cmd.exe /c start "" "$url" >/dev/null 2>&1 || true
        say '已打开浏览器。' "$C_GREEN"
        return 0
      fi
      ;;
    *)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url" >/dev/null 2>&1 &
        disown 2>/dev/null || true
        say '已打开浏览器。' "$C_GREEN"
        return 0
      fi
      ;;
  esac
  say "没找到可用的浏览器打开方式，请手动访问：$url" "$C_YELLOW"
  return 0
}

# -----------------------------------------------------------------------------
# 参数
# -----------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      if [ "$#" -lt 2 ]; then
        say '--port 后面要跟端口号，例如 --port 8899' "$C_RED"
        exit 1
      fi
      PORT="$2"
      shift
      ;;
    --port=*)
      PORT="${1#--port=}"
      ;;
    --stop)
      DO_STOP=1
      ;;
    --status)
      DO_STATUS=1
      ;;
    --no-browser)
      NO_BROWSER=1
      ;;
    --foreground)
      FOREGROUND=1
      ;;
    --keep-open)
      KEEP_OPEN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        EXTRA[$EXTRA_N]="$1"
        EXTRA_N=$((EXTRA_N + 1))
        shift
      done
      break
      ;;
    *)
      say "未知参数：$1" "$C_RED"
      usage
      exit 1
      ;;
  esac
  shift
done

case "$PORT" in
  ''|*[!0-9]*)
    say "端口号必须是数字，收到：$PORT" "$C_RED"
    exit 1
    ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  say "端口号超出范围（1-65535）：$PORT" "$C_RED"
  exit 1
fi

# 项目根 = 本脚本所在目录
SELF="$0"
case "$SELF" in
  */*) : ;;
  *)
    FOUND="$(command -v "$SELF" 2>/dev/null || true)"
    if [ -n "$FOUND" ]; then
      SELF="$FOUND"
    fi
    ;;
esac
ROOT="$(cd "$(dirname "$SELF")" 2>/dev/null && pwd -P)" || ROOT=''
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
  say "定位不到脚本所在目录（脚本路径：$SELF）。请用完整路径运行：bash /完整路径/start-engine.sh" "$C_RED"
  exit 1
fi
cd "$ROOT"

ENTRY="$ROOT/tools/gateway.js"
URL="http://127.0.0.1:$PORT/"
GATEWAY_LOG="$ROOT/tools/gateway.log"

# 依赖探测（--status 在缺 node 时也要能给出结论，所以这里不直接退出）
HAVE_NODE=0
NODE_BIN=''
NODE_VER=''
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  HAVE_NODE=1
  NODE_BIN="$(command -v node)"
  NODE_VER="$(node -v 2>/dev/null || true)"
  NODE_MAJOR="${NODE_VER#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  case "$NODE_MAJOR" in
    ''|*[!0-9]*) NODE_MAJOR=0 ;;
  esac
fi

HAVE_CURL=0
if command -v curl >/dev/null 2>&1; then
  HAVE_CURL=1
fi

# -----------------------------------------------------------------------------
# --status：只读，先于一切“动手”的逻辑
# -----------------------------------------------------------------------------
if [ "$DO_STATUS" = "1" ]; then
  show_status "$PORT"
  exit 2
fi

say '== hentai搜索 · 本地引擎 ==' "$C_CYAN"
say "项目目录：$ROOT"

if [ ! -f "$ENTRY" ]; then
  say "找不到 $ENTRY" "$C_RED"
  exit 1
fi

if [ "$HAVE_NODE" != "1" ]; then
  say '没找到 node，请先安装 Node.js 18+ 并确保它在 PATH 里。' "$C_RED"
  say '  macOS：brew install node   或者到 https://nodejs.org/ 下载安装包' "$C_GRAY"
  say '  Linux：用发行版包管理器装 nodejs（版本要 18 以上）' "$C_GRAY"
  exit 1
fi
say "Node：$NODE_BIN（$NODE_VER）"
if [ "$NODE_MAJOR" -lt 18 ]; then
  say "警告：node 版本偏低（$NODE_VER），建议 18 或更高；遇到怪问题先升级 node。" "$C_YELLOW"
fi
if [ "$HAVE_CURL" != "1" ]; then
  say '提示：本机没有 curl，改用 node 直接请求 /api/ping 与 /api/reader（功能不受影响）。' "$C_GRAY"
fi

# 1) 停掉占用端口的旧 node 引擎（别的进程一律不碰）
if ! stop_engine "$PORT"; then
  exit 1
fi

if [ "$DO_STOP" = "1" ]; then
  say '已按要求只做停止操作。' "$C_GREEN"
  exit 2
fi

# 2) 起新引擎
if [ "$FOREGROUND" = "1" ]; then
  say "前台运行：node tools/gateway.js --port $PORT（日志就在这里，Ctrl+C 停止）" "$C_GRAY"
  set +e
  if [ "$EXTRA_N" -gt 0 ]; then
    node tools/gateway.js --port "$PORT" "${EXTRA[@]}"
  else
    node tools/gateway.js --port "$PORT"
  fi
  RC=$?
  set -e
  exit "$RC"
fi

say "启动：node tools/gateway.js --port $PORT（后台，日志 → tools/gateway.log）" "$C_GRAY"
{
  printf '\n===== launcher %s : node tools/gateway.js --port %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$PORT"
} >> "$GATEWAY_LOG" 2>/dev/null || true

if [ "$EXTRA_N" -gt 0 ]; then
  nohup node tools/gateway.js --port "$PORT" "${EXTRA[@]}" >> "$GATEWAY_LOG" 2>&1 &
else
  nohup node tools/gateway.js --port "$PORT" >> "$GATEWAY_LOG" 2>&1 &
fi
ENGINE_PID=$!
disown 2>/dev/null || true

# 3) 等 /api/ping 就绪（最多 30 次 × 0.9s）
say '等待就绪…' "$C_GRAY"
PING_BODY=''
i=1
while [ "$i" -le 30 ]; do
  sleep 0.9
  PING_BODY="$(http_get "http://127.0.0.1:$PORT/api/ping" 5)"
  if [ -n "$PING_BODY" ]; then
    break
  fi
  i=$((i + 1))
done

if [ -z "$PING_BODY" ]; then
  printf '\n'
  say '引擎没能就绪（被占用 / 起不来 / 初始化超时 / 出口被墙都可能）。' "$C_YELLOW"
  if kill -0 "$ENGINE_PID" 2>/dev/null; then
    say "进程 PID=$ENGINE_PID 还在，但 $PORT 上一直没有响应。" "$C_YELLOW"
  else
    say "进程 PID=$ENGINE_PID 已经退出了。" "$C_YELLOW"
  fi
  say "日志尾部（tools/gateway.log）：" "$C_YELLOW"
  if [ -f "$GATEWAY_LOG" ]; then
    tail -n 20 "$GATEWAY_LOG" 2>/dev/null || true
  else
    say '  （日志文件还没生成）' "$C_GRAY"
  fi
  printf '\n'
  say "想看完整报错，直接在前台跑一遍：./start-engine.sh --port $PORT --foreground" "$C_GRAY"
  say "如果 $PORT 被别的程序占了，换个端口：./start-engine.sh --port 8899" "$C_GRAY"
  exit 1
fi

# 4) 自检
printf '\n'
say '== 自检 ==' "$C_CYAN"
if [ "$(json_field "$PING_BODY" has_pixiv)" = "1" ]; then
  say '版本：新版本（/api/nhentai/search · /api/pixiv/search · /api/reader 都在）' "$C_GREEN"
else
  say '版本：异常，刚启动的应该是新版本，请检查是否真的换成了新进程' "$C_RED"
fi
say "出口：$(json_field "$PING_BODY" egress)" "$C_GRAY"

check_reader nhentai 682396 'nhentai 在线阅读'
check_reader mangadex a2c1d849-af05-4bbc-b2a7-866ebb10331f 'mangadex 在线阅读'

printf '\n'
say "引擎已就绪：$URL" "$C_GREEN"
say "提示：引擎在后台跑（PID=$ENGINE_PID），日志写在 tools/gateway.log。" "$C_GRAY"
say '      只停引擎：./start-engine.sh --stop     只看状态：./start-engine.sh --status' "$C_GRAY"

if [ "$NO_BROWSER" != "1" ]; then
  open_browser "$URL"
fi

# 退出码约定（与 Windows 版一致）：
#   0 = 引擎已就绪，启动器可以退出
#   2 = 正常收尾但要保留输出（--status / --stop / --keep-open）
#   1 = 失败
if [ "$KEEP_OPEN" = "1" ]; then
  say '引擎已就绪（--keep-open：本终端保留输出）。' "$C_GREEN"
  exit 2
fi
say '引擎已在后台运行（启动器退出不影响它）。' "$C_GREEN"
exit 0
