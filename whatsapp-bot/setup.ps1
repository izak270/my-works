# ==============================================================
#  WhatsApp Agent Bot — התקנה אוטומטית מלאה (Windows)
#  הרצה: פתח PowerShell והדבק:
#  irm https://raw.githubusercontent.com/izak270/my-works/claude/whatsapp-bot-active-messaging-1vawci/whatsapp-bot/setup.ps1 | iex
# ==============================================================
$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "===== שלב 1/4: בדיקת Node.js =====" -ForegroundColor Cyan
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js לא מותקן — מנסה להתקין אוטומטית (winget)..." -ForegroundColor Yellow
    try {
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
        # רענון PATH בתוך אותו חלון
        $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
        $node = Get-Command node -ErrorAction SilentlyContinue
    } catch {
        $node = $null
    }
    if (-not $node) {
        Write-Host ""
        Write-Host "לא הצלחתי להתקין אוטומטית. התקן ידנית מ-https://nodejs.org (כפתור LTS)," -ForegroundColor Red
        Write-Host "סגור ופתח PowerShell מחדש, והדבק שוב את אותה שורת התקנה." -ForegroundColor Red
        return
    }
}
Write-Host ("Node מותקן: " + (node -v)) -ForegroundColor Green

Write-Host ""
Write-Host "===== שלב 2/4: הורדת הקוד =====" -ForegroundColor Cyan
$dest = Join-Path $HOME 'whatsapp-bot'
$zip  = Join-Path $env:TEMP 'wabot.zip'
$tmp  = Join-Path $env:TEMP 'wabot-extract'
Invoke-WebRequest -Uri 'https://github.com/izak270/my-works/archive/refs/heads/claude/whatsapp-bot-active-messaging-1vawci.zip' -OutFile $zip
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Expand-Archive -Path $zip -DestinationPath $tmp -Force
if (Test-Path $dest) {
    # שומרים צימוד והגדרות קיימים אם יש
    foreach ($keep in @('.env', '.wwebjs_auth')) {
        $old = Join-Path $dest $keep
        if (Test-Path $old) { Move-Item $old (Join-Path $tmp $keep) -Force }
    }
    Remove-Item -Recurse -Force $dest
}
Move-Item (Join-Path $tmp 'my-works-claude-whatsapp-bot-active-messaging-1vawci\whatsapp-bot') $dest
foreach ($keep in @('.env', '.wwebjs_auth')) {
    $saved = Join-Path $tmp $keep
    if (Test-Path $saved) { Move-Item $saved (Join-Path $dest $keep) -Force }
}
Set-Location $dest
Write-Host ("הקוד הותקן ב: " + $dest) -ForegroundColor Green

Write-Host ""
Write-Host "===== שלב 3/4: הגדרות =====" -ForegroundColor Cyan
if (-not (Test-Path .env)) {
    Set-Content -Path .env -Value 'BOT_ENABLED=false' -Encoding UTF8
    Write-Host "נוצר .env במצב חיבור-בלבד (הבוט מאזין ולא עונה)." -ForegroundColor Green
} else {
    Write-Host "נמצא .env קיים — נשמר כמו שהוא." -ForegroundColor Green
}

Write-Host ""
Write-Host "===== שלב 4/4: התקנת תלויות (כמה דקות בפעם הראשונה) =====" -ForegroundColor Cyan
npm install

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host " הכל מוכן! מפעיל את הבוט..." -ForegroundColor Green
Write-Host " ה-QR יופיע כאן בטרמינל וגם בדפדפן:" -ForegroundColor Green
Write-Host "   http://127.0.0.1:3000" -ForegroundColor Green
Write-Host " סרוק מהטלפון של המספר האמריקאי:" -ForegroundColor Green
Write-Host " וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
npm start
