<#
  hentai搜索 —— 本地引擎（网关）一键启动器
  ---------------------------------------------------------------
  它替你做完这一串事：
    1 找到占用端口的旧网关进程（只认 node，别的进程绝不动）
    2 停掉它（旧版本没有 /api/reader、没有 nhentai / pixiv 路由）
    3 用当前代码起一个新引擎（在新窗口里跑，日志看得见）
    4 等它就绪，然后真的打一遍接口自检：
      /api/ping 是不是新版本；/api/reader 能不能取到 nhentai 与 mangadex 的页
    5 打开浏览器页面

  用法（在项目根目录执行）：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-gateway.ps1
  或者直接双击项目根目录的 start-gateway.cmd

  常用参数：
    -Port 8788            换端口
    -Stop                 只停引擎，不启动
    -Status               只看状态（是否在跑、是不是新版本）
    -NoBrowser            启动后不自动开浏览器
    -GatewayArgs @(...)   透传给网关的额外参数，例如 "--ehentai-cookie=..."
  本脚本按 Windows PowerShell 5.1 语法写（不使用 7.x 专有语法）。
#>
[CmdletBinding()]
param(
  [int]$Port = 8788,
  [switch]$Stop,
  [switch]$Status,
  [switch]$NoBrowser,
  # -Foreground：不新开窗口，直接在当前窗口运行引擎（日志就在这里，Ctrl+C 停止）
  [switch]$Foreground,
  # -KeepOpen：引擎就绪后不要自动关闭启动器窗口（默认会自动关，只留下引擎那个窗口）
  [switch]$KeepOpen,
  [string[]]$GatewayArgs = @()
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path $Root 'tools\gateway.js'
$Url = 'http://127.0.0.1:' + $Port + '/'

function Say {
  param([string]$Msg, [string]$Color = 'Gray')
  Write-Host $Msg -ForegroundColor $Color
}

function Test-Gateway {
  param([int]$P)
  try {
    $uri = 'http://127.0.0.1:' + $P + '/api/ping'
    $r = Invoke-WebRequest -Uri $uri -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -eq 200) { return ($r.Content | ConvertFrom-Json) }
  } catch { }
  return $null
}

function Get-ListenerPid {
  param([int]$P)
  try {
    $c = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction Stop
    if ($c) {
      $first = $c | Select-Object -First 1
      return [int]$first.OwningProcess
    }
  } catch { }
  try {
    $pat = ':{0}\s+\S+\s+LISTENING\s+(\d+)\s*$' -f $P
    $lines = & netstat.exe -ano 2>$null
    foreach ($line in $lines) {
      if ($line -match $pat) { return [int]$Matches[1] }
    }
  } catch { }
  return 0
}

function Stop-Engine {
  param([int]$P)
  $ownerPid = Get-ListenerPid -P $P
  if (-not $ownerPid) {
    Say ('端口 ' + $P + ' 上没有监听进程（引擎本来就没在跑）') 'DarkGray'
    return $true
  }
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    Say ('端口 ' + $P + ' 的持有者 PID=' + $ownerPid + ' 已不存在') 'DarkGray'
    return $true
  }
  if ($proc.ProcessName -ne 'node') {
    Say ('警告：端口 ' + $P + ' 被 PID=' + $ownerPid + '（' + $proc.ProcessName + '）占用，那不是本引擎，我不动它，请自行处理。') 'Yellow'
    return $false
  }
  try {
    Stop-Process -Id $ownerPid -Force
    Start-Sleep -Milliseconds 800
    Say ('已停掉旧引擎（PID=' + $ownerPid + '，启动于 ' + $proc.StartTime + '）') 'Green'
    return $true
  } catch {
    Say ('停止 PID=' + $ownerPid + ' 失败：' + $_.Exception.Message) 'Red'
    return $false
  }
}

function Show-Status {
  param([int]$P)
  $ping = Test-Gateway -P $P
  if (-not $ping) {
    Say ('引擎：未运行（端口 ' + $P + ' 无响应）') 'Yellow'
    return
  }
  $src = @($ping.sources) -join ', '
  $isNew = @($ping.sources) -contains 'pixiv'
  Say ('引擎：运行中  version=' + $ping.version + '  出口=' + $ping.egress) 'Green'
  Say ('  sources: ' + $src) 'Gray'
  if ($isNew) {
    Say '  版本：新版本（含 pixiv / nhentai / 在线阅读路由）' 'Green'
  } else {
    Say '  版本：旧进程（没有 pixiv，也就没有 /api/reader）→ 需要重启' 'Red'
  }
  try {
    $uri = 'http://127.0.0.1:' + $P + '/api/reader?source=nhentai&id=682396'
    $rd = Invoke-WebRequest -Uri $uri -TimeoutSec 30 -UseBasicParsing
    $j = $rd.Content | ConvertFrom-Json
    $pages = @($j.pages).Count
    $line = '  在线阅读测试：nhentai ok=' + $j.ok + ' pages=' + $pages
    if ($j.ok) { Say $line 'Green' } else { Say $line 'Red' }
  } catch {
    Say '  在线阅读测试：接口无响应' 'Red'
  }
}

if ($Status) {
  Show-Status -P $Port
  exit 2
}

Say '== hentai搜索 · 本地引擎 ==' 'Cyan'
Say ('项目目录：' + $Root)
if (-not (Test-Path $Entry)) {
  Say ('找不到 ' + $Entry) 'Red'
  exit 1
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Say '没找到 node，请先安装 Node.js 18+ 并确保它在 PATH 里' 'Red'
  exit 1
}
Say ('Node：' + $nodeCmd.Source)

if (-not (Stop-Engine -P $Port)) { exit 1 }

if ($Stop) {
  Say '已按要求只做停止操作。' 'Green'
  exit 2
}

$argList = @('tools/gateway.js', '--port', ([string]$Port)) + $GatewayArgs
$shown = $argList -join ' '
if (-not $Foreground) {
  Say ('启动：node ' + $shown + '（新窗口）') 'Gray'
  try {
    Start-Process -FilePath $nodeCmd.Source -ArgumentList $argList -WorkingDirectory $Root | Out-Null
  } catch {
    Say ('新窗口启动失败：' + $_.Exception.Message) 'Yellow'
  }
}

$ping = $null
$waitLoops = 30
if ($Foreground) { $waitLoops = 0 }
if ($waitLoops -gt 0) {
  Say '等待就绪…' 'Gray'
  for ($i = 1; $i -le $waitLoops; $i++) {
    Start-Sleep -Milliseconds 900
    $ping = Test-Gateway -P $Port
    if ($ping) { break }
  }
}
if (-not $ping) {
  Write-Host ''
  Say '新窗口没能就绪（受限环境 / 端口被占用 / 进程立刻退出都可能）。' 'Yellow'
  Say '改为在当前窗口直接运行引擎 —— 下面就是它的日志，按 Ctrl+C 可停止。' 'Yellow'
  Write-Host ''
  & $nodeCmd.Source @argList
  exit $LASTEXITCODE
}

Write-Host ''
Say '== 自检 ==' 'Cyan'
$isNew = @($ping.sources) -contains 'pixiv'
if ($isNew) {
  Say '版本：新版本（/api/nhentai/search · /api/pixiv/search · /api/reader 都在）' 'Green'
} else {
  Say '版本：异常，刚启动的应该是新版本，请检查是否真的换成了新进程' 'Red'
}
Say ('出口：' + $ping.egress) 'Gray'

$checks = @(
  @{ name = 'nhentai 在线阅读'; url = '/api/reader?source=nhentai&id=682396' },
  @{ name = 'mangadex 在线阅读'; url = '/api/reader?source=mangadex&id=a2c1d849-af05-4bbc-b2a7-866ebb10331f' }
)
foreach ($c in $checks) {
  $nm = [string]$c.name
  $uri = 'http://127.0.0.1:' + $Port + [string]$c.url
  try {
    $rd = Invoke-WebRequest -Uri $uri -TimeoutSec 45 -UseBasicParsing
    $j = $rd.Content | ConvertFrom-Json
    if ($j.ok) {
      $pages = @($j.pages).Count
      $chaps = @($j.chapters).Count
      $extra = ''
      if ($chaps -gt 0) { $extra = ' / ' + $chaps + ' 话' }
      Say ('  [OK] ' + $nm + '：' + $pages + ' 页' + $extra) 'Green'
    } else {
      Say ('  [--] ' + $nm + '：' + $j.error) 'Yellow'
    }
  } catch {
    Say ('  [--] ' + $nm + '：接口报错 ' + $_.Exception.Message) 'Yellow'
  }
}

Write-Host ''
Say ('引擎已就绪：' + $Url) 'Green'
Say '提示：引擎跑在刚才新开的那个窗口里，关掉那个窗口就等于停止引擎。' 'DarkGray'
Say '      只停引擎：本脚本加 -Stop     只看状态：本脚本加 -Status' 'DarkGray'

if (-not $NoBrowser) {
  try {
    Start-Process $Url | Out-Null
    Say '已打开浏览器。' 'Green'
  } catch { }
}

# 退出码约定（start-gateway.cmd 靠它决定要不要自动关窗口）：
#   0 = 引擎已在新窗口就绪 -> 启动器可以自动关闭
#   2 = 正常收尾但需要保留窗口（-Status / -Stop / -KeepOpen）
#   1 = 失败 -> 保留窗口看报错
if ($KeepOpen) {
  Say '引擎已就绪（-KeepOpen：本窗口保留，按任意键关闭）。' 'Green'
  exit 2
}
Say '引擎已在新窗口运行；启动器窗口 3 秒后自动关闭（引擎不受影响）。' 'Green'
exit 0
