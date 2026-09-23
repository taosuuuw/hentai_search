<#
  hentai搜索 —— 自建中继「一次性设置」向导
  ===============================================================
  它解决的事：
    e-hentai / pixiv 在**本机出口上没有任何通路**（连 15 条公共中继也全灭，实测见
    tools/relay-deploy.md），唯一出路是你自己的一台墙外中继。这是一次性动作 ——
    做完一次，以后每次启动都会自动跳过（状态记在 tools\.relay-setup.json）。

  被谁调用：
    · 正常情况：tools\start-gateway.ps1 启动时会自动问一次（只在交互式窗口里问）
    · 想手动重跑：powershell -NoProfile -ExecutionPolicy Bypass -File tools\relay-setup.ps1 -Force
    · 想恢复「以后不再问」：加 -Reset（或删掉 tools\.relay-setup.json）

  参数：
    -Auto        由启动脚本调用（不打印无关内容）
    -Force       忽略「已完成」状态，强制进入向导
    -Reset       先清除设置状态，再进入向导
    -Quiet       成功跳过时不打印那行提示
    -DryRun      只打印将要执行的命令，不做任何改动（用于自测）
    -AssumeInteractive  仅用于自动化测试：把「输入被重定向」也当作交互式（否则一律不打断）
    -Port 8788   引擎端口（只用于提示语）

  重要工程约定（本机实测的坑）：
    ⚠ 本文件**必须带 UTF-8 BOM**（首三字节 EF BB BF）。Windows PowerShell 5.1 对没有 BOM 的
      文件按 GBK 解码，中文全角字符的 UTF-8 字节会被两两当成 GBK，可能吃掉字符串的结束引号
      ⇒ 整份脚本 ParserError（实测：Unexpected token 'Red' / Missing closing ')'）。
      仓库的写文件工具默认不写 BOM，**改完这个文件一定要补回 BOM**：
        $t=[IO.File]::ReadAllText($p,(New-Object Text.UTF8Encoding $false)); `
        [IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding $true))
      tools\start-gateway.ps1 启动前还会自己检查一遍并就地补 BOM（双保险）；
      tools\relay-check.js 也有一条断言钉住「所有 .ps1 都必须带 BOM」。
    ⚠ 参数名不能叫 $Args —— 那是 PowerShell 的自动变量，声明同名参数后 splat 会被空的自动变量
      顶掉，症状是「node 收不到参数、只打印用法」。本文件里参数数组一律用 $hArgs。
    ⚠ PowerShell 5.1 的 Invoke-WebRequest 在本机**连不上任何外网 HTTPS**
      （pages.dev / npm 源 / Cloudflare 全部报「基础连接已经关闭」，而同一时刻 Node 全部 200）
      ⇒ 本脚本所有外部连通性检查都走 node（tools/relay-setup.js --probe-hosting / --verify），
        绝不用 Invoke-WebRequest 判断「外网是否可达」。
  本脚本按 Windows PowerShell 5.1 语法写（不使用 7.x 专有语法）。
#>
[CmdletBinding()]
param(
  [switch]$Auto,
  [switch]$Force,
  [switch]$Reset,
  [switch]$Quiet,
  [switch]$DryRun,
  [switch]$AssumeInteractive,
  [int]$Port = 8788
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Helper = Join-Path $Root 'tools\relay-setup.js'
$RelayFile = Join-Path $Root 'tools\relay.txt'
$DeployDir = Join-Path $Root 'tools\_relay-deploy'
$WorkerSrc = Join-Path $Root 'tools\relay-worker.mjs'
$DeployLog = Join-Path $Root 'tools\_relay-deploy.log'
$RelayServer = Join-Path $Root 'tools\relay-server.js'
$DeployDoc = Join-Path $Root 'tools\relay-deploy.md'

function Say {
  param([string]$Msg, [string]$Color = 'Gray')
  Write-Host $Msg -ForegroundColor $Color
}
function Head {
  param([string]$Msg)
  Write-Host ''
  Say $Msg 'Cyan'
}
function Ask {
  # Read-Host 在「输入被重定向且已读空」时返回 $null，直接 .Trim() 会抛
  # «You cannot call a method on a null-valued expression» ⇒ 一律用这个包一层。
  param([string]$Prompt)
  return ('' + (Read-Host $Prompt)).Trim()
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) { Say '没找到 node，跳过中继设置向导（装好 Node.js 18+ 再启动即可）' 'Yellow'; exit 1 }
$NodeExe = $NodeCmd.Source

# node 的输出按 UTF-8 收，避免中文 JSON 串在 GBK 控制台下变乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

function Invoke-Helper {
  # ⚠ 参数名不能叫 $Args：那是 PowerShell 的自动变量，声明同名参数后 splat 会被那个空变量顶掉，
  #   症状是「node 收不到任何参数，只回一段用法文本」。本文件里参数数组一律用 $hArgs。
  param([string[]]$HelperArgs)
  try { return (& $NodeExe $Helper @HelperArgs 2>$null | Out-String) } catch { return '' }
}
function Get-Status {
  param([bool]$Interactive)
  $flag = '--interactive=0'
  if ($Interactive) { $flag = '--interactive=1' }
  $hArgs = @('--status', $flag)
  if ($Force) { $hArgs += '--force' }
  $txt = Invoke-Helper -HelperArgs $hArgs
  try { return ($txt | ConvertFrom-Json) } catch { return $null }
}
function Test-Interactive {
  if ($AssumeInteractive) { return $true }
  try { return (-not [Console]::IsInputRedirected) } catch { return $false }
}
function Mark-State {
  param([string]$Status, [string]$Method = '', [string]$Url = '', [string]$Note = '')
  if ($DryRun) { Say ('[DryRun] 会执行：node tools\relay-setup.js --mark=' + $Status) 'DarkGray'; return }
  $hArgs = @('--mark=' + $Status)
  if ($Method) { $hArgs += '--method=' + $Method }
  if ($Url) { $hArgs += '--url=' + $Url }
  if ($Note) { $hArgs += '--note=' + $Note }
  Invoke-Helper -HelperArgs $hArgs | Out-Null
}
function Save-Relay {
  param([string]$Url, [string]$Key, [string]$Method)
  # ⚠ 每个 `+` 都要自己加括号：PowerShell 里逗号比 `+` 结合得更紧，
  #   @('a' + $x, 'b' + $y) 会被解析成 'a' + ($x, 'b') + $y —— 数组被 + 拍平成
  #   一个用空格连接的字符串，于是 node 只收到一个参数（实测：地址里混进了 --method=manual）。
  $hArgs = @(('--set-relay=' + $Url), ('--method=' + $Method))
  if ($Key) { $hArgs += '--key=' + $Key }
  if ($DryRun) { Say ('[DryRun] 会执行：node tools\relay-setup.js ' + ($hArgs -join ' ')) 'DarkGray'; return $true }
  $txt = Invoke-Helper -HelperArgs $hArgs
  try { $j = $txt | ConvertFrom-Json } catch { Say ('写入失败：' + $txt) 'Red'; return $false }
  if (-not $j.ok) { Say ('写入失败：' + $j.err) 'Red'; return $false }
  Say ('已写入 ' + $RelayFile + '：' + $j.wrote.url + '  （key ' + $(if ($j.wrote.keyPresent) { '已设置' } else { '为空' }) + '）') 'Green'
  return $true
}
function Confirm-Relay {
  param([string]$Url, [string]$Key)
  if ($DryRun) { Say '[DryRun] 跳过 --verify' 'DarkGray'; return $true }
  $hArgs = @('--verify')
  if ($Url) { $hArgs += '--url=' + $Url }
  if ($Key) { $hArgs += '--key=' + $Key }
  $txt = Invoke-Helper -HelperArgs $hArgs
  try { $v = $txt | ConvertFrom-Json } catch { Say ('验证没拿到结果：' + $txt) 'Yellow'; return $false }
  if ($v.ok) {
    $line = '  [OK] 中继活着：' + $v.relay + ' v' + $v.version + '（' + $v.ms + 'ms）'
    Say $line 'Green'
    if ($v.egressIp) { Say ('       中继出口 IP：' + $v.egressIp + '  ← 目标站看到的就是这个 IP') 'Green' }
    elseif ($v.egressIpError) { Say ('       出口 IP 没取到：' + $v.egressIpError + '（不影响中转，只是探针打不到 ipify）') 'DarkGray' }
    # ★key 验真★：--verify 会**带 key 再打一次代理请求**（/__hs/ping 不需要 key，只打它证明不了 key 对不对）。
    if ($v.keyOk -eq $true) { Say ('       key 已验真：带 key 的代理请求 HTTP 200（' + $v.keyMs + 'ms）') 'Green' }
    return $true
  }
  # 先报 warn：key 不对时 $v.status 会是 200，只显示「HTTP 200」会把人带偏。
  Say ('  [--] 中继没回应：' + $(if ($v.warn) { $v.warn } elseif ($v.err) { $v.err } else { 'HTTP ' + $v.status }) + '（' + $v.ms + 'ms）') 'Yellow'
  Say '       常见原因：项目刚部署还没生效 / 地址写错 / key 不对 / 该域名在本机被墙。' 'DarkGray'
  return $false
}
function Get-Npx {
  foreach ($n in @('npx.cmd', 'npx')) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
  }
  $guess = Join-Path (Split-Path -Parent $NodeExe) 'npx.cmd'
  if (Test-Path $guess) { return $guess }
  return $null
}

function Show-Why {
  Say 'e-hentai 与 pixiv 在**本机出口**上没有任何通路（连 15 条公共中继也全灭），必须有一台' 'Gray'
  Say '墙外的中继。这是**一次性**设置：做完这一次，以后启动会自动跳过这一步。' 'Gray'
  Say '说明书（含原理与实测证据）：tools\relay-deploy.md' 'DarkGray'
}

function Invoke-Option1 {
  Head '① 自动部署到 Cloudflare Pages'
  Say '先检查前置条件（npm 源 / Cloudflare 能不能连）…' 'Gray'
  $txt = Invoke-Helper -HelperArgs @('--probe-hosting')
  try { $p = $txt | ConvertFrom-Json } catch { Say '前置检查失败（拿不到结果）' 'Yellow'; return $false }
  foreach ($t in $p.targets) {
    $mark = '[--]'
    $color = 'Yellow'
    if ($t.ok) { $mark = '[OK]'; $color = 'Green' }
    $detail = ''
    if ($t.ok) { $detail = 'HTTP ' + $t.status + '  ' + $t.ms + 'ms' } else { $detail = $t.err }
    Say ('  ' + $mark + ' ' + $t.id.PadRight(14) + $detail) $color
  }
  if (-not $p.ok) {
    Say '' 
    Say '前置条件不满足 ⇒ 本机没法自动部署。请改用 [2]（在别的机器/手机上部署好，把地址粘过来）。' 'Yellow'
    return $false
  }
  if (-not (Test-Path $WorkerSrc)) { Say ('找不到 ' + $WorkerSrc) 'Red'; return $false }
  if ($DryRun) {
    Say '[DryRun] 会执行：复制 relay-worker.mjs → tools\_relay-deploy\_worker.js' 'DarkGray'
    Say '[DryRun] 会执行：npx --yes wrangler@latest whoami（未登录则先 wrangler login 开浏览器授权）' 'DarkGray'
    Say '[DryRun] 会执行：npx --yes wrangler@latest pages project create <名> --production-branch=main' 'DarkGray'
    Say ('[DryRun] 会执行：npx --yes wrangler@latest pages deploy <dir> --project-name=<名> --commit-dirty=true') 'DarkGray'
    Say ('[DryRun] 会执行：node tools\relay-setup.js --gen-key ；npx wrangler pages secret put HS_RELAY_KEY') 'DarkGray'
    return $false
  }
  $npx = Get-Npx
  if (-not $npx) { Say '没找到 npx（Node 装了但 npx 不在 PATH）⇒ 请改用 [2] 手动粘贴地址。' 'Yellow'; return $false }
  # ① 先确认登录：wrangler 不会自己替你去登录，未登录时部署只会报一句 not authenticated
  Say '检查 Cloudflare 登录状态…' 'Gray'
  $who = ''
  try { $who = (& $npx --yes wrangler@latest whoami 2>&1 | Out-String) } catch { $who = '' }
  if ($who -match 'not authenticated|You are not authenticated|未登录') {
    Say '还没登录 Cloudflare —— 现在打开浏览器让你授权（只需一次）。' 'Yellow'
    try { & $npx --yes wrangler@latest login 2>&1 | Tee-Object -FilePath $DeployLog | Out-Null } catch { }
    $who = ''
    try { $who = (& $npx --yes wrangler@latest whoami 2>&1 | Out-String) } catch { $who = '' }
    if ($who -match 'not authenticated|You are not authenticated|未登录') {
      Say '登录没成功 ⇒ 请改用 [2]（在别的机器 / 手机上部署好，把地址粘过来）。' 'Yellow'
      return $false
    }
    Say '登录成功。' 'Green'
  } else {
    Say '已登录。' 'Gray'
  }
  New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null
  Copy-Item $WorkerSrc (Join-Path $DeployDir '_worker.js') -Force
  $proj = Read-Host 'Cloudflare Pages 项目名（直接回车 = 自动取名）'
  if (-not $proj) { $proj = 'hs-relay-' + (Get-Random -Minimum 1000 -Maximum 9999) }
  # ② 先把项目建出来：这一步能把「账号邮箱未验证」这种账号级问题当场暴露出来
  Say ''
  Say ('创建 / 确认 Pages 项目 ' + $proj + ' …') 'Gray'
  # ⚠ 两个坑叠在一起：① `$ErrorActionPreference = 'Stop'`（见 :51）会把 native 命令的 stderr 升级成
  #   终止错误，catch 里的 $_.Exception.Message 只含**第一行** —— 实测正好丢掉 `already exists`
  #   / `[code: 8000002]`，于是「项目已存在」这条特判形同虚设；② `*>` 重定向也救不了：实测 stderr
  #   绕过重定向，文件里只剩 48 字节的 wrangler banner。唯一稳的写法 = **临时把偏好设回 Continue**，
  #   让 `2>&1` 把 stderr 当数据并进管道（隔离复现：LEN=892、MATCH=True）。
  $pc = ''
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $pc = (& $npx --yes wrangler@latest pages project create $proj --production-branch=main 2>&1 | Out-String) } catch { $pc = ('' + $_.Exception.Message) + "`n" + $pc }
  $ErrorActionPreference = $eap
  if ($pc -match 'must been verified|8000077') {
    Say ''
    Say 'Cloudflare 拒绝了：**你这个账号的邮箱还没验证**（错误码 8000077）。' 'Red'
    Say '  解决：打开 dash.cloudflare.com → 右上角头像 → My Profile → 找到「邮箱未验证 / Resend verification email」' 'Yellow'
    Say '  → 去收件箱（含垃圾邮件）点 Cloudflare 那封验证链接 → 回来重新选 [1]。' 'Yellow'
    return $false
  }
  # 重跑向导（第二次以后）必然撞到这条：项目已经建过了。wrangler 会打一整片红字
  # （`A project with this name already exists. Choose a different project name. [code: 8000002]`），
  # 但对我们来说这是**正常情况** —— 复用已有项目，继续往下部署即可。这里把红字翻译成一句人话。
  if ($pc -match 'already exists|8000002') {
    Say ('项目 ' + $proj + ' 已经存在 ⇒ 直接复用它（重跑向导时的正常情况，不是错误）。') 'Gray'
  }
  Say ''
  Say '接下来 wrangler 会**打开浏览器让你登录 Cloudflare**（只需一次），然后自动上传并给出网址。' 'Yellow'
  Say '（如果它问 Create a new project? 选 Y；其余回车即可。）' 'DarkGray'
  Say ''
  # ⚠ 每个 `+` 都要自己加括号：PowerShell 里逗号比 `+` 结合得更紧，
  #   @('a' + $x, 'b') 会被拍成 @('a', $x, 'b') —— 实测后果是 `--project-name=` 与项目名被拆成
  #   两个参数，wrangler 直接报 `Unknown argument: hs-relay-a7f3`（第 14 处修正；同一个坑第 2 次踩，见 :115）。
  $cmd = @('--yes', 'wrangler@latest', 'pages', 'deploy', $DeployDir, ('--project-name=' + $proj), '--commit-dirty=true')
  Say ('执行：npx ' + ($cmd -join ' ')) 'DarkGray'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    & $npx @cmd 2>&1 | Tee-Object -FilePath $DeployLog | Out-Null
  } catch {
    Say ('wrangler 执行失败：' + $_.Exception.Message) 'Yellow'
  }
  $sw.Stop()
  $log = ''
  if (Test-Path $DeployLog) { $log = (Get-Content $DeployLog -Raw) }
  Say ('（wrangler 用了 ' + [int]($sw.Elapsed.TotalSeconds) + ' 秒，完整输出：tools\_relay-deploy.log）') 'DarkGray'
  $urls = @()
  foreach ($m in [regex]::Matches($log, 'https://[A-Za-z0-9\-\.]+\.pages\.dev')) { if ($urls -notcontains $m.Value) { $urls += $m.Value } }
  if ($urls.Count -eq 0 -and $log -match 'must been verified|8000077') {
    Say ''
    Say 'Cloudflare 拒绝了：**你这个账号的邮箱还没验证**（错误码 8000077）。' 'Red'
    Say '  解决：dash.cloudflare.com → 头像 → My Profile → 重发验证邮件 → 点邮箱里的链接 → 重新选 [1]。' 'Yellow'
    return $false
  }
  if ($urls.Count -eq 0 -and $log -match 'not authenticated|You are not authenticated') {
    Say ''
    Say 'wrangler 说「没登录」⇒ 先手动跑一次 npx --yes wrangler@latest login，再回来选 [1]。' 'Yellow'
    return $false
  }
  if ($urls.Count -eq 0) {
    Say ''
    Say '没能从输出里认出部署网址 ⇒ 自动部署这条路这次没走通。' 'Yellow'
    Say '请到 Cloudflare 控制台的 Pages 项目页复制网址，然后用 [2] 粘贴进来（10 秒）。' 'Yellow'
    return $false
  }
  $url = $urls[$urls.Count - 1]
  Say ('部署完成：' + $url) 'Green'

  $key = (Invoke-Helper -HelperArgs @('--gen-key')).Trim()
  Say ''
  Say ('为它设一个 key（访问口令）：' + $key) 'Yellow'
  Say '  （脚本会尝试用 wrangler 自动写入 Secret HS_RELAY_KEY；失败就去控制台 Settings → Variables and Secrets 手动加）' 'DarkGray'
  try {
    # ★绝对不要用 `$key | & npx … pages secret put`★（2026-09-23 实测踩到的坑）：
    #   PowerShell 5.1 把字符串管道喂给 npx.cmd 时，**存进去的值不是 $key** ——
    #   secret put 照样报 `Success! Uploaded secret HS_RELAY_KEY`、/__hs/ping 也报 keyRequired:true，
    #   但用这个 key 打中继一律 403；key 的 10 种变形（CR/LF/CRLF×N/空格/引号）也全部 403。
    #   原因在 worker 侧不做 trim（tools/relay-worker.mjs:106），存进去的确实是另一个值。
    #   确定性的做法：把 key 写进一个**无换行**的临时文件，再用 cmd 的 `<` 交给 wrangler
    #   （实测同一份 key 这样写进去，带 key 的代理请求立刻 200/pong）。用完马上删。
    $keyFile = Join-Path $Root 'tools\_relay-key.tmp'
    [IO.File]::WriteAllText($keyFile, $key, (New-Object Text.UTF8Encoding $false))
    try {
      $secCmd = '"' + $npx + '" --yes wrangler@latest pages secret put HS_RELAY_KEY --project-name=' + $proj + ' < "' + $keyFile + '"'
      & $env:ComSpec /c $secCmd 2>&1 | Tee-Object -FilePath $DeployLog -Append | Out-Null
    } finally { Remove-Item $keyFile -Force -ErrorAction SilentlyContinue }
    Say '  已尝试写入 Secret（成功与否看上面输出 / 控制台里有没有 HS_RELAY_KEY）' 'Gray'
  } catch {
    Say ('  自动写 Secret 失败：' + $_.Exception.Message + ' ⇒ 请去控制台手动加 HS_RELAY_KEY=' + $key) 'Yellow'
  }

  # ★Pages 的 Secret 只对**之后的新部署**生效★（2026-09-23 实测：secret put 之后不重新部署，
  # /__hs/ping 仍报 keyRequired:false —— key 形同虚设，中继对任何知道地址的人开放）。
  # 所以写完 Secret 一定再部署一次。
  Say '  再部署一次，让刚写的 Secret 生效（Pages 的 Secret 只影响之后的部署）…' 'DarkGray'
  try {
    & $npx --yes wrangler@latest pages deploy $DeployDir --project-name=$proj --commit-dirty=true 2>&1 |
      Tee-Object -FilePath $DeployLog -Append | Out-Null
  } catch { }
  Start-Sleep -Seconds 3

  # ★先验证、后落盘★（2026-09-23，和 [2]/[3]/[4] 统一）：刚部署完 Cloudflare 常常要几秒才全网生效，
  # 所以第一次验不过就等 6 秒再验一次；两次都验不过就**不改动**现有配置（relay.txt 保持原样），
  # 并把地址与 key 打出来，让用户可以直接用 [2] 粘进来（不用再跑一次部署）。
  # ★优先用**生产别名** `https://<项目名>.pages.dev`：wrangler 的输出里只有本次部署的哈希 URL
  # （实测：部署日志里两个 `https://<hash>.hs-relay-a7f3.pages.dev`，别名一个字都没有），
  # 而别名永远指向最新一次生产部署、也更好记。别名验不过（自定义域名 / 别名还没生效）就退回本次部署 URL。
  $alias = 'https://' + $proj + '.pages.dev'
  $cands = @()
  if ($alias -ne $url) { $cands += $alias }
  $cands += $url
  $urlUse = ''
  foreach ($c in $cands) {
    Say ('  验证中继是否活着（/__hs/ping）：' + $c) 'Gray'
    if (Confirm-Relay -Url $c -Key $key) { $urlUse = $c; break }
  }
  if (-not $urlUse) {
    Start-Sleep -Seconds 6
    Say '  再验一次（Cloudflare 刚部署可能还没生效）…' 'Gray'
    foreach ($c in $cands) { if (Confirm-Relay -Url $c -Key $key) { $urlUse = $c; break } }
  }
  if (-not $urlUse) {
    Say ''
    Say '验证没通过 ⇒ **不改动**现有配置（tools\relay.txt 与状态都保持原样）。' 'Yellow'
    Say ('  地址：' + $url) 'Yellow'
    Say ('  key ：' + $key) 'Yellow'
    Say '  等 10 秒后选 [2] 把这两行粘进来即可（10 秒，不用重新部署）；或到控制台确认 HS_RELAY_KEY 在不在。' 'Yellow'
    return $false
  }
  if (-not (Save-Relay -Url $urlUse -Key $key -Method 'cf-pages')) { return $false }
  Start-Sleep -Seconds 3
  return $true
}

function Invoke-Option2 {
  Head '② 我已经有中继地址（粘贴即可）'
  Say '在**任何能上外网的机器或手机**上按 tools\relay-deploy.md 部署一次（Cloudflare Pages / Deno / VPS 都行），' 'Gray'
  Say '把得到的网址（和 key，如果设了）粘进来。' 'Gray'
  $url = (Ask '中继地址（例如 https://xxx.pages.dev）')
  if (-not $url) { Say '没输入地址，取消。' 'Yellow'; return $false }
  $key = (Ask 'key（没设过就直接回车）')
  # ★先验证、后落盘★（2026-09-23 实测出来的次序问题，见 tools\relay-deploy.md「其他路径实测」）
  # 旧写法是先 Save-Relay 再 Confirm-Relay：地址或 key 打错时，relay.txt 已被改写、状态已变
  # configured，而用户原来跑通的那个中继就此丢失 —— 更糟的是以后启动都会「自动跳过」，
  # 用户再也不会被问到，只能自己发现 e-hentai 又搜不到了。现在验证不过就一个字节都不动。
  if (-not (Confirm-Relay -Url $url -Key $key)) {
    Say ''
    Say '验证没通过 ⇒ **不改动**现有配置（tools\relay.txt 与状态都保持原样）。' 'Yellow'
    Say '  核对地址（末尾别带 /）与 key 后重新选 [2]；想彻底清空重来：tools\relay-setup.ps1 -Reset' 'DarkGray'
    return $false
  }
  if (-not (Save-Relay -Url $url -Key $key -Method 'manual')) { return $false }
  if (-not $DryRun) {
    Say ''
    $live = Read-Host '要不要顺便用真目标测一遍（打 e-hentai / pixiv，约 30 秒）？[y/N]'
    if ($live -match '^[Yy]') {
      Say '跑 node tools\relay-check.js --live=1 …' 'Gray'
      try { & $NodeExe (Join-Path $Root 'tools\relay-check.js') --live=1 2>&1 | Select-Object -Last 25 } catch { }
    }
  }
  return $true
}

function Invoke-Option3 {
  param([switch]$LocalOnly)
  if ($LocalOnly) { Head '④ 本机自测中继（救不了被墙的站，只验链路）' } else { Head '③ 墙外 VPS / 软路由：跑 tools\relay-server.js' }
  if ($LocalOnly) {
    Say '本机中继与网关**同出口** ⇒ 对 e-hentai / pixiv 没有任何帮助（物理上出口没变）。' 'Yellow'
    Say '它只用来验证「中继实现 + 网关接线」这条链路是通的。' 'DarkGray'
  } else {
    Say '把仓库里的 tools\relay-server.js 拷到那台墙外机器（Node 18+，零依赖），然后运行：' 'Gray'
    Say '    node tools\relay-server.js --host=0.0.0.0 --port=8790 --key=<你的key>' 'White'
    Say '再把它的公网地址（含 http(s):// 与端口）粘进来。' 'Gray'
    Say '注意：用 IP 直连时中继没有 TLS，key 会在明文里传 —— 自己可控的线路可以接受。' 'DarkGray'
  }
  $host_ = (Ask '地址（回车 = http://127.0.0.1:8790）')
  if (-not $host_) { $host_ = 'http://127.0.0.1:8790' }
  $key = (Ask 'key（回车 = 自动生成一个）')
  if (-not $key -and -not $DryRun) { $key = (Invoke-Helper -HelperArgs @('--gen-key')).Trim(); Say ('自动生成的 key：' + $key) 'Green' }
  if ($host_ -match '^https?://[^/]*127\.0\.0\.1' -or $host_ -match 'localhost') {
    if (-not $DryRun) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DeployLog) | Out-Null
      $port = 8790
      $m = [regex]::Match($host_, ':(\d+)')
      if ($m.Success) { $port = [int]$m.Groups[1].Value }
      Say ('正在新窗口启动本机中继：node tools\relay-server.js --port=' + $port + ' --key=<key>') 'Gray'
      try {
        $a = @('tools/relay-server.js', '--port', ([string]$port), '--key', $key)
        Start-Process -FilePath $NodeExe -ArgumentList $a -WorkingDirectory $Root | Out-Null
        Start-Sleep -Seconds 2
      } catch { Say ('启动本机中继失败：' + $_.Exception.Message) 'Yellow' }
    }
  } elseif (-not $LocalOnly) {
    Say '提示：那台机器上的中继要记得放行端口，并在防火墙/安全组里开它。' 'DarkGray'
  }
  # ★先验证、后落盘★（同 Invoke-Option2 的理由：地址写错不能把已经跑通的中继冲掉）
  if (-not (Confirm-Relay -Url $host_ -Key $key)) {
    Say ''
    Say '验证没通过 ⇒ **不改动**现有配置（tools\relay.txt 与状态都保持原样）。' 'Yellow'
    Say '  本机中继：确认端口没被占用、地址与 key 一致；VPS：确认端口已放行、地址是本机。' 'DarkGray'
    return $false
  }
  if (-not (Save-Relay -Url $host_ -Key $key -Method $(if ($LocalOnly) { 'local-test' } else { 'vps' }))) { return $false }
  return $true
}

function Invoke-Option5 {
  Head '⑤ 稍后再说 / 不再提醒'
  Say '  [1] 稍后再说（下次交互式启动还会问）' 'Gray'
  Say '  [2] 不再提醒（永久跳过这一步；想恢复：tools\relay-setup.ps1 -Reset）' 'Gray'
  $c = (Ask '选择 [1/2]')
  if ($c -eq '2') {
    Mark-State -Status 'skipped' -Note '用户在向导里选择不再提醒'
    Say '好，以后不再问。e-hentai / pixiv 会一直搜不到，直到你配置中继。' 'Green'
  } else {
    Mark-State -Status 'deferred'
    Say '好，这次跳过。' 'Green'
  }
  return $true
}

function Show-Wizard {
  Head '== 一次性设置：自建中继（打通 e-hentai / pixiv）=='
  Show-Why
  Say ''
  Say '  ★[1] 是推荐选项★ 直接回车也能选它：本机全程自动做完，你只需要在弹出的浏览器里' 'Green'
  Say '      点一次「登录 / 授权」（Cloudflare 账号，没有就现场注册一个免费号），其余不用管。' 'Green'
  Say ''
  Say '  [1] ★推荐★ 自动部署到 Cloudflare Pages（一键：5 项自检 → 登录 → 建项目 → 部署 → 生成 key →' 'White'
  Say '            写入 Secret → 再部署 → 验证，只有「浏览器点一次登录」需要人工）' 'White'
  Say '  [2] 我已经有中继地址（粘贴网址，10 秒）' 'White'
  Say '  [3] 我自己有墙外 VPS / 软路由（跑 tools\relay-server.js）' 'White'
  Say '  [4] 本机自测中继（只验链路，救不了被墙的站）' 'White'
  Say '  [5] 稍后再说 / 不再提醒' 'White'
  Say "  [?] 打开说明书 tools\relay-deploy.md" 'DarkGray'
  Say "  [q] 退出（什么都不改）" 'DarkGray'
  Say ''
  $c = (Ask '请选择（直接回车 = 推荐项 [1]）')
  # 空回车 = 选推荐项：把「推荐」真的做成默认，而不是只写在文案里
  if (-not $c) { Say '  → 直接采用推荐项 [1]。' 'DarkGray'; $c = '1' }
  switch ($c) {
    '1' { if (Invoke-Option1) { return 'done' } else { return 'retry' } }
    '2' { if (Invoke-Option2) { return 'done' } else { return 'retry' } }
    '3' { if (Invoke-Option3) { return 'done' } else { return 'retry' } }
    '4' { if (Invoke-Option3 -LocalOnly) { return 'done' } else { return 'retry' } }
    '5' { Invoke-Option5 | Out-Null; return 'done' }
    '?' { if (Test-Path $DeployDoc) { try { Start-Process $DeployDoc | Out-Null; Say '已打开说明书。' 'Green' } catch { Say ('看这份文件：' + $DeployDoc) 'Yellow' } }; return 'retry' }
    'q' { Say '退出，未做任何改动。' 'Gray'; return 'quit' }
    default { Say '没看懂这个选项。' 'Yellow'; return 'retry' }
  }
}

# ---------------- 主流程 ----------------

if (-not (Test-Path $Helper)) { Say ('找不到 ' + $Helper) 'Red'; exit 1 }

if ($Reset) {
  if ($DryRun) { Say '[DryRun] 会执行：node tools\relay-setup.js --reset' 'DarkGray' }
  else { Invoke-Helper -HelperArgs @('--reset') | Out-Null; Say '已清除中继设置状态（下次启动会重新询问；tools\relay.txt 保留）。' 'Green' }
}

$interactive = Test-Interactive
$st = Get-Status -Interactive $interactive
if (-not $st) { Say '读不到设置状态（helper 没输出），本次跳过向导。' 'Yellow'; exit 1 }

if ($st.decision.action -eq 'silent') {
  if (-not $Quiet -and -not $Auto) {
    if ($st.relayConfigured) {
      Say ('自建中继：已配置（' + $st.relayUrl + '）—— 一次性步骤已完成，自动跳过。' ) 'DarkGray'
    } else {
      Say ('自建中继：未配置（' + $st.decision.detail + '）。' ) 'DarkGray'
    }
  }
  exit 0
}

if (-not $interactive) {
  # 非交互式（被脚本/任务调用、输入被重定向）：绝不阻塞，记一笔就走
  Mark-State -Status 'deferred' -Note '非交互式启动，向导没跑'
  exit 0
}

$attempt = 0
while ($attempt -lt 6) {
  $attempt++
  $r = Show-Wizard
  if ($r -eq 'done' -or $r -eq 'quit') { break }
  Say '再试一次，或者按 q 退出。' 'DarkGray'
}

$st2 = Get-Status -Interactive $true
if ($st2 -and $st2.relayConfigured) {
  Head '完成'
  Say ('中继：' + $st2.relayUrl) 'Green'
  Say '以后启动会自动跳过这一步（状态在 tools\.relay-setup.json；想重跑加 -Force，想恢复提问加 -Reset）。' 'Green'
  Say ('接下来启动引擎时网关就会用它 —— 私有中继会排在全部公共中继前面（端口 ' + $Port + '）。') 'Gray'
  exit 0
}
exit 0
