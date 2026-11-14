param(
  [int]$PreferredPort = 0,
  [int]$TestPort = 0,
  [string]$InitialCwd = "",
  [switch]$DryRunJson
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$HubStateDir = Join-Path $RootDir ".agent-hub"
$PrefsPath = Join-Path $HubStateDir "desktop-prefs.json"
$RuntimePath = Join-Path $HubStateDir "runtime.json"

function U([string]$Text) {
  return [regex]::Unescape($Text)
}

function Test-TcpPortAvailable([int]$Port) {
  if ($Port -lt 1024 -or $Port -gt 65535) {
    return $false
  }
  foreach ($addr in @([System.Net.IPAddress]::Any, [System.Net.IPAddress]::Loopback)) {
    $listener = $null
    try {
      $listener = [System.Net.Sockets.TcpListener]::new($addr, $Port)
      $listener.ExclusiveAddressUse = $true
      $listener.Start()
      $listener.Stop()
    } catch {
      if ($listener -ne $null) {
        try { $listener.Stop() } catch {}
      }
      return $false
    }
  }
  return $true
}

function Find-FreeTcpPort([int]$StartPort = 4317, [int]$MaxScan = 100) {
  $base = if ($StartPort -ge 1024 -and $StartPort -le 65535) { $StartPort } else { 4317 }
  for ($offset = 0; $offset -le $MaxScan; $offset++) {
    $candidate = $base + $offset
    if ($candidate -gt 65535) { break }
    if (Test-TcpPortAvailable $candidate) {
      return $candidate
    }
  }
  $ephemeral = $null
  try {
    $ephemeral = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $ephemeral.Start()
    $port = ([System.Net.IPEndPoint]$ephemeral.LocalEndpoint).Port
    $ephemeral.Stop()
    return $port
  } catch {
    if ($ephemeral -ne $null) {
      try { $ephemeral.Stop() } catch {}
    }
    return 4317
  }
}

function Load-DesktopPrefs {
  $defaults = [ordered]@{
    port = 4317
    cwd = $RootDir
    autoExit = $true
  }
  if (-not (Test-Path $PrefsPath)) {
    return $defaults
  }
  try {
    $raw = Get-Content -Path $PrefsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($raw.port -and ([int]$raw.port -ge 1024) -and ([int]$raw.port -le 65535)) {
      $defaults.port = [int]$raw.port
    }
    if ($raw.cwd -and (Test-Path $raw.cwd)) {
      $defaults.cwd = [string]$raw.cwd
    }
    if ($null -ne $raw.autoExit) {
      $defaults.autoExit = [bool]$raw.autoExit
    }
  } catch {
    # Ignore corrupted prefs and use defaults
  }
  return $defaults
}

function Save-DesktopPrefs([int]$Port, [string]$Cwd, [bool]$AutoExit) {
  if (-not (Test-Path $HubStateDir)) {
    New-Item -ItemType Directory -Path $HubStateDir -Force | Out-Null
  }
  $payload = [ordered]@{
    port = $Port
    cwd = $Cwd
    autoExit = $AutoExit
    updatedAt = (Get-Date).ToString("o")
  }
  $json = $payload | ConvertTo-Json -Depth 3
  [System.IO.File]::WriteAllText($PrefsPath, $json, [System.Text.UTF8Encoding]::new($false))
}

function Resolve-NodeExecutable {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
  }
  if ($cmd -and $cmd.Source) {
    return $cmd.Source
  }
  foreach ($candidate in @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
  )) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }
  return $null
}

function Get-RunningHubInfo {
  if (-not (Test-Path $RuntimePath)) {
    return $null
  }
  try {
    $rt = Get-Content -Path $RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $rt.url -or -not $rt.pid) {
      return $null
    }
    $proc = Get-Process -Id ([int]$rt.pid) -ErrorAction SilentlyContinue
    if (-not $proc) {
      return $null
    }
    $healthUrl = "$($rt.url.TrimEnd('/'))/api/health"
    $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 -ErrorAction Stop
    if ($resp -and $resp.ok) {
      return [ordered]@{
        url = [string]$rt.url
        port = [int]($(if ($resp.port) { $resp.port } else { $rt.port }))
        baseCwd = [string]$resp.baseCwd
        pid = [int]$rt.pid
      }
    }
  } catch {
    return $null
  }
  return $null
}

function Find-AppBrowser {
  $candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) {
      return $p
    }
  }
  return $null
}

function Open-DesktopWindow([string]$Url) {
  if (-not (Test-Path $HubStateDir)) {
    New-Item -ItemType Directory -Path $HubStateDir -Force | Out-Null
  }
  $profileDir = Join-Path $HubStateDir "desktop-browser-profile"
  if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
  }
  $browser = Find-AppBrowser
  if ($browser) {
    $browserArgs = @(
      "--app=$Url",
      "--user-data-dir=$profileDir",
      "--window-size=1420,900",
      "--no-first-run",
      "--no-default-browser-check"
    )
    Start-Process -FilePath $browser -ArgumentList $browserArgs | Out-Null
    return
  }
  Start-Process $Url | Out-Null
}

function Quote-Arg([string]$Value) {
  if ($Value -match '[\s"]') {
    $escaped = $Value.Replace('"', '\"')
    return '"' + $escaped + '"'
  }
  return $Value
}

$prefs = Load-DesktopPrefs
$targetPreferred = if ($PreferredPort -gt 0) { $PreferredPort } else { [int]$prefs.port }
$suggestedPort = Find-FreeTcpPort -StartPort $targetPreferred -MaxScan 100
$defaultCwd = if ($InitialCwd -and (Test-Path $InitialCwd)) { $InitialCwd } else { [string]$prefs.cwd }
$nodeExe = Resolve-NodeExecutable
$runningInfo = Get-RunningHubInfo

if ($DryRunJson) {
  $checkedTestPort = if ($TestPort -gt 0) { $TestPort } else { $suggestedPort }
  $report = [ordered]@{
    ok = $true
    preferredPort = $targetPreferred
    suggestedPort = $suggestedPort
    suggestedPortAvailable = (Test-TcpPortAvailable $suggestedPort)
    testPort = $checkedTestPort
    testPortAvailable = (Test-TcpPortAvailable $checkedTestPort)
    defaultCwd = $defaultCwd
    nodeExe = $nodeExe
    runningUrl = if ($runningInfo) { $runningInfo.url } else { $null }
  }
  Write-Output ($report | ConvertTo-Json -Compress)
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$bgColor = [System.Drawing.Color]::FromArgb(247, 245, 240)
$cardColor = [System.Drawing.Color]::White
$textColor = [System.Drawing.Color]::FromArgb(29, 29, 26)
$mutedColor = [System.Drawing.Color]::FromArgb(107, 102, 93)
$accentColor = [System.Drawing.Color]::FromArgb(184, 84, 44)
$okColor = [System.Drawing.Color]::FromArgb(13, 113, 72)
$errColor = [System.Drawing.Color]::FromArgb(185, 28, 28)

$form = New-Object System.Windows.Forms.Form
$form.Text = U "Quorum \u684c\u9762\u542f\u52a8\u5668"
$iconPath = Join-Path $RootDir "src\ui\icon.ico"
if (Test-Path $iconPath) { $form.Icon = New-Object System.Drawing.Icon($iconPath) }
$form.ClientSize = New-Object System.Drawing.Size(520, 350)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.BackColor = $bgColor
$form.ForeColor = $textColor
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5)

$yOffset = 18

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = "Quorum"
$titleLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 14, [System.Drawing.FontStyle]::Bold)
$titleLabel.Location = New-Object System.Drawing.Point(24, $yOffset)
$titleLabel.AutoSize = $true
$form.Controls.Add($titleLabel)

$subLabel = New-Object System.Windows.Forms.Label
$subLabel.Text = U "\u542f\u52a8\u524d\u914d\u7f6e\u672c\u5730\u670d\u52a1\u7aef\u53e3\u4e0e\u5de5\u4f5c\u533a"
$subLabel.ForeColor = $mutedColor
$subLabel.Location = New-Object System.Drawing.Point(24, ($yOffset + 30))
$subLabel.AutoSize = $true
$form.Controls.Add($subLabel)
$yOffset += 62

if ($runningInfo) {
  $runningPanel = New-Object System.Windows.Forms.Panel
  $runningPanel.Location = New-Object System.Drawing.Point(24, $yOffset)
  $runningPanel.Size = New-Object System.Drawing.Size(472, 36)
  $runningPanel.BackColor = [System.Drawing.Color]::FromArgb(234, 245, 239)

  $runningText = New-Object System.Windows.Forms.Label
  $runningText.Text = (U "\u5df2\u68c0\u6d4b\u5230\u8fd0\u884c\u4e2d\u5b9e\u4f8b: ") + $runningInfo.url
  $runningText.ForeColor = $okColor
  $runningText.Location = New-Object System.Drawing.Point(10, 9)
  $runningText.Size = New-Object System.Drawing.Size(345, 20)
  $runningPanel.Controls.Add($runningText)

  $openRunningBtn = New-Object System.Windows.Forms.Button
  $openRunningBtn.Text = U "\u6253\u5f00\u7a97\u53e3"
  $openRunningBtn.Location = New-Object System.Drawing.Point(370, 5)
  $openRunningBtn.Size = New-Object System.Drawing.Size(92, 26)
  $openRunningBtn.FlatStyle = [System.Windows.Forms.FlatStyle]::System
  $openRunningBtn.Add_Click({
    Open-DesktopWindow -Url $runningInfo.url
    $form.Close()
  })
  $runningPanel.Controls.Add($openRunningBtn)
  $form.Controls.Add($runningPanel)
  $yOffset += 46
  $form.ClientSize = New-Object System.Drawing.Size(520, 396)
}

$portLabel = New-Object System.Windows.Forms.Label
$portLabel.Text = U "\u670d\u52a1\u7aef\u53e3 (1024-65535)"
$portLabel.Location = New-Object System.Drawing.Point(24, $yOffset)
$portLabel.AutoSize = $true
$form.Controls.Add($portLabel)
$yOffset += 24

$portBox = New-Object System.Windows.Forms.TextBox
$portBox.Text = [string]$suggestedPort
$portBox.Location = New-Object System.Drawing.Point(24, $yOffset)
$portBox.Size = New-Object System.Drawing.Size(160, 28)
$portBox.BackColor = $cardColor
$form.Controls.Add($portBox)

$autoPortBtn = New-Object System.Windows.Forms.Button
$autoPortBtn.Text = U "\u81ea\u52a8\u5206\u914d"
$autoPortBtn.Location = New-Object System.Drawing.Point(194, ($yOffset - 1))
$autoPortBtn.Size = New-Object System.Drawing.Size(104, 28)
$autoPortBtn.FlatStyle = [System.Windows.Forms.FlatStyle]::System
$form.Controls.Add($autoPortBtn)
$yOffset += 32

$portStatusLabel = New-Object System.Windows.Forms.Label
$portStatusLabel.Location = New-Object System.Drawing.Point(24, $yOffset)
$portStatusLabel.Size = New-Object System.Drawing.Size(472, 22)
$form.Controls.Add($portStatusLabel)
$yOffset += 32

$cwdLabel = New-Object System.Windows.Forms.Label
$cwdLabel.Text = U "\u5de5\u4f5c\u533a\u76ee\u5f55"
$cwdLabel.Location = New-Object System.Drawing.Point(24, $yOffset)
$cwdLabel.AutoSize = $true
$form.Controls.Add($cwdLabel)
$yOffset += 24

$cwdBox = New-Object System.Windows.Forms.TextBox
$cwdBox.Text = $defaultCwd
$cwdBox.Location = New-Object System.Drawing.Point(24, $yOffset)
$cwdBox.Size = New-Object System.Drawing.Size(374, 28)
$cwdBox.BackColor = $cardColor
$form.Controls.Add($cwdBox)

$browseBtn = New-Object System.Windows.Forms.Button
$browseBtn.Text = U "\u6d4f\u89c8..."
$browseBtn.Location = New-Object System.Drawing.Point(406, ($yOffset - 1))
$browseBtn.Size = New-Object System.Drawing.Size(90, 28)
$browseBtn.FlatStyle = [System.Windows.Forms.FlatStyle]::System
$form.Controls.Add($browseBtn)
$yOffset += 38

$autoExitCheck = New-Object System.Windows.Forms.CheckBox
$autoExitCheck.Text = U "\u5173\u95ed\u6240\u6709\u684c\u9762\u7a97\u53e3\u540e\u81ea\u52a8\u505c\u6b62\u540e\u53f0\u670d\u52a1"
$autoExitCheck.Checked = [bool]$prefs.autoExit
$autoExitCheck.Location = New-Object System.Drawing.Point(24, $yOffset)
$autoExitCheck.Size = New-Object System.Drawing.Size(472, 24)
$form.Controls.Add($autoExitCheck)
$yOffset += 34

$launchErrorLabel = New-Object System.Windows.Forms.Label
$launchErrorLabel.ForeColor = $errColor
$launchErrorLabel.Location = New-Object System.Drawing.Point(24, $yOffset)
$launchErrorLabel.Size = New-Object System.Drawing.Size(472, 22)
$form.Controls.Add($launchErrorLabel)
$yOffset += 30

$shortcutBtn = New-Object System.Windows.Forms.Button
$shortcutBtn.Text = U "\u521b\u5efa\u684c\u9762\u5feb\u6377\u65b9\u5f0f"
$shortcutBtn.Location = New-Object System.Drawing.Point(24, $yOffset)
$shortcutBtn.Size = New-Object System.Drawing.Size(144, 34)
$shortcutBtn.FlatStyle = [System.Windows.Forms.FlatStyle]::System
$form.Controls.Add($shortcutBtn)

$cancelBtn = New-Object System.Windows.Forms.Button
$cancelBtn.Text = U "\u53d6\u6d88"
$cancelBtn.Location = New-Object System.Drawing.Point(280, $yOffset)
$cancelBtn.Size = New-Object System.Drawing.Size(90, 34)
$cancelBtn.FlatStyle = [System.Windows.Forms.FlatStyle]::System
$form.Controls.Add($cancelBtn)

$startBtn = New-Object System.Windows.Forms.Button
$startBtn.Text = U "\u542f\u52a8\u5de5\u4f5c\u53f0"
$startBtn.Location = New-Object System.Drawing.Point(378, $yOffset)
$startBtn.Size = New-Object System.Drawing.Size(118, 34)
$startBtn.BackColor = $accentColor
$startBtn.ForeColor = [System.Drawing.Color]::White
$startBtn.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$startBtn.FlatAppearance.BorderSize = 0
$form.Controls.Add($startBtn)

$script:portValid = $false

$updatePortStatus = {
  $raw = $portBox.Text.Trim()
  $parsed = 0
  if (-not [int]::TryParse($raw, [ref]$parsed) -or $parsed -lt 1024 -or $parsed -gt 65535) {
    $script:portValid = $false
    $portStatusLabel.ForeColor = $errColor
    $portStatusLabel.Text = U "x \u8bf7\u8f93\u5165 1024-65535 \u4e4b\u95f4\u7684\u6574\u6570"
    $startBtn.Enabled = $false
    return
  }
  if (Test-TcpPortAvailable $parsed) {
    $script:portValid = $true
    $portStatusLabel.ForeColor = $okColor
    $portStatusLabel.Text = (U "+ \u7aef\u53e3 ") + $parsed + (U " \u7a7a\u95f2\u53ef\u7528")
    $startBtn.Enabled = $true
  } else {
    $script:portValid = $false
    $portStatusLabel.ForeColor = $errColor
    $portStatusLabel.Text = (U "x \u7aef\u53e3 ") + $parsed + (U " \u5df2\u88ab\u5360\u7528\u6216\u65e0\u6548")
    $startBtn.Enabled = $false
  }
}

$portBox.Add_TextChanged($updatePortStatus)

$autoPortBtn.Add_Click({
  $seed = 4317
  $tmp = 0
  if ([int]::TryParse($portBox.Text.Trim(), [ref]$tmp) -and $tmp -ge 1024 -and $tmp -le 65535) {
    $seed = $tmp + 1
  }
  $free = Find-FreeTcpPort -StartPort $seed -MaxScan 100
  $portBox.Text = [string]$free
  & $updatePortStatus
})

$browseBtn.Add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = U "\u9009\u62e9 Quorum \u9ed8\u8ba4\u5de5\u4f5c\u533a\u76ee\u5f55"
  if ($cwdBox.Text -and (Test-Path $cwdBox.Text)) {
    $dlg.SelectedPath = $cwdBox.Text
  }
  $dlg.ShowNewFolderButton = $true
  if ($dlg.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) {
    $cwdBox.Text = $dlg.SelectedPath
  }
  $dlg.Dispose()
})

$shortcutBtn.Add_Click({
  try {
    $desktopDir = [Environment]::GetFolderPath("Desktop")
    $lnkPath = Join-Path $desktopDir "Quorum.lnk"
    $vbsPath = Join-Path $RootDir "AgentHub.vbs"
    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($lnkPath)
    $sc.TargetPath = "wscript.exe"
    $sc.Arguments = '//nologo "' + $vbsPath + '"'
    $sc.WorkingDirectory = $RootDir
    $sc.Description = "Quorum Desktop Workbench"
    if (Test-Path $iconPath) { $sc.IconLocation = $iconPath }
    $sc.Save()
    $launchErrorLabel.ForeColor = $okColor
    $launchErrorLabel.Text = (U "\u5df2\u521b\u5efa\u684c\u9762\u5feb\u6377\u65b9\u5f0f: ") + $lnkPath
  } catch {
    $launchErrorLabel.ForeColor = $errColor
    $launchErrorLabel.Text = $_.Exception.Message
  }
})

$cancelBtn.Add_Click({
  $form.Close()
})

$startBtn.Add_Click({
  & $updatePortStatus
  if (-not $script:portValid) {
    return
  }
  $chosenPort = [int]$portBox.Text.Trim()
  $chosenCwd = $cwdBox.Text.Trim()
  if (-not $chosenCwd -or -not (Test-Path $chosenCwd)) {
    $launchErrorLabel.ForeColor = $errColor
    $launchErrorLabel.Text = (U "\u5de5\u4f5c\u533a\u76ee\u5f55\u4e0d\u5b58\u5728: ") + $chosenCwd
    return
  }
  $resolvedNode = Resolve-NodeExecutable
  $tsxCli = Join-Path $RootDir "node_modules\tsx\dist\cli.mjs"
  $srcEntry = Join-Path $RootDir "src\index.ts"
  $distEntry = Join-Path $RootDir "dist\index.js"

  $entryArgs = @()
  $useDist = $false
  if (Test-Path $distEntry) {
    $distTime = (Get-Item $distEntry).LastWriteTimeUtc
    $newerTs = Get-ChildItem -Path (Join-Path $RootDir "src") -Recurse -File -Filter "*.ts" -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTimeUtc -gt $distTime } |
      Select-Object -First 1
    if (-not $newerTs) {
      $useDist = $true
    }
  }
  if ($useDist) {
    $entryArgs = @($distEntry)
  } elseif ((Test-Path $tsxCli) -and (Test-Path $srcEntry)) {
    $entryArgs = @($tsxCli, $srcEntry)
  } elseif (Test-Path $distEntry) {
    $entryArgs = @($distEntry)
  }

  if (-not $resolvedNode -or $entryArgs.Count -eq 0) {
    $launchErrorLabel.ForeColor = $errColor
    $launchErrorLabel.Text = U "\u672a\u627e\u5230 Node.js \u6216\u7f16\u8bd1\u4ea7\u7269"
    return
  }

  $startBtn.Enabled = $false
  $startBtn.Text = U "\u6b63\u5728\u542f\u52a8..."
  $launchErrorLabel.Text = ""
  $form.Refresh()

  Save-DesktopPrefs -Port $chosenPort -Cwd $chosenCwd -AutoExit $autoExitCheck.Checked

  if (-not (Test-Path $HubStateDir)) {
    New-Item -ItemType Directory -Path $HubStateDir -Force | Out-Null
  }
  $stdoutLog = Join-Path $HubStateDir "desktop.stdout.log"
  $stderrLog = Join-Path $HubStateDir "desktop.stderr.log"

  $hubArgs = @() + $entryArgs + @(
    "--desktop",
    "--strict-port",
    "--no-open",
    "--port", [string]$chosenPort,
    "--cwd", $chosenCwd
  )
  if ($autoExitCheck.Checked) {
    $hubArgs += "--auto-exit"
  }
  $argString = ($hubArgs | ForEach-Object { Quote-Arg $_ }) -join " "

  $proc = Start-Process -FilePath $resolvedNode `
    -ArgumentList $argString `
    -WorkingDirectory $RootDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  $healthUrl = "http://127.0.0.1:$chosenPort/api/health"
  $ready = $false
  for ($i = 0; $i -lt 75; $i++) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 200
    if ($proc.HasExited) {
      break
    }
    try {
      $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 -ErrorAction Stop
      if ($resp -and $resp.ok) {
        $ready = $true
        break
      }
    } catch {
      # Keep polling until healthy or timeout
    }
  }

  if (-not $ready) {
    if (-not $proc.HasExited) {
      try { $proc.Kill() } catch {}
    }
    $launchErrorLabel.ForeColor = $errColor
    $launchErrorLabel.Text = (U "\u540e\u53f0\u670d\u52a1\u542f\u52a8\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7: ") + $stderrLog
    $startBtn.Text = U "\u542f\u52a8\u5de5\u4f5c\u53f0"
    & $updatePortStatus
    return
  }

  Open-DesktopWindow -Url "http://127.0.0.1:$chosenPort"
  $form.Close()
})

$form.AcceptButton = $startBtn
$form.CancelButton = $cancelBtn
$form.Add_Shown({
  $form.TopMost = $true
  $form.Activate()
  $form.TopMost = $false
})
& $updatePortStatus
[void]$form.ShowDialog()
