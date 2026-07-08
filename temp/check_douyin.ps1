# 读取抖音网页版当前标签页标题
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File "check_douyin.ps1"
# 输出写入 C:\Users\ASUS\claude_douyin.txt

$outputFile = "$env:USERPROFILE\claude_douyin.txt"

# 获取所有浏览器窗口的标题，筛选包含"抖音"的
$browsers = @("msedge", "chrome", "firefox")

$found = $false
foreach ($browser in $browsers) {
    $windows = Get-Process -Name $browser -ErrorAction SilentlyContinue | ForEach-Object {
        $_.MainWindowTitle
    } | Where-Object { $_ -match "抖音" }

    if ($windows) {
        foreach ($title in $windows) {
            if ($title -and $title.Trim() -ne "") {
                # 抖音网页版标题格式：通常是 "视频描述前几个字 - 抖音" 或 "作者名的作品 - 抖音"
                # 也可能在直播/搜索页
                $clean = $title.Trim()
                "[抖音] $clean" | Out-File -FilePath $outputFile -Encoding UTF8
                $found = $true
            }
        }
    }
}

if (-not $found) {
    "[抖音未在浏览器中打开]" | Out-File -FilePath $outputFile -Encoding UTF8
}
