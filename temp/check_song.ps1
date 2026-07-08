# 读取酷狗当前播放歌曲，输出到用户目录下的文件
$OutFile = "$env:USERPROFILE\claude_song.txt"

$processes = Get-Process -Name KuGou -ErrorAction SilentlyContinue
$raw = ""
foreach ($p in $processes) {
    if ($p.MainWindowTitle -ne '') {
        $raw = $p.MainWindowTitle
        break
    }
}

if ($raw -eq "") {
    $raw = "[酷狗未在播放歌曲]"
}

[System.IO.File]::WriteAllText($OutFile, $raw, [System.Text.UTF8Encoding]::new($false))
Write-Output "OK: $raw"
