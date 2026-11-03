# Runs Claude Code headless on a brief, visibly, logging to logs\. Usage: .\scripts\run-claude.ps1 docs\phase-1.md [logname]
param([string]$Brief = 'docs\phase-1.md', [string]$Log = 'claude-tv-rendition')
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force logs | Out-Null
$prompt = "Read $Brief (and docs/PLAN.md) and implement it fully in this repo. Work only inside this folder. Commit in logical chunks and git push origin main after each chunk. Never commit secrets or media. Do NOT stop/restart the running production server (node src\server.js, port 8090) or any ffmpeg you did not start; never contact the IPTV provider. Stop any processes you start before finishing. End with a short summary: commits, measured numbers, anything unfinished."
$tools = 'Read,Edit,Write,Glob,Grep,TodoWrite,WebFetch,Bash(node:*),Bash(npm:*),Bash(npx:*),Bash(git:*),Bash(ffmpeg:*),Bash(ffprobe:*),Bash(*ffmpeg.exe*),Bash(*ffprobe.exe*),Bash(*msedge.exe*),Bash(ls:*),Bash(dir:*),Bash(mkdir:*),Bash(cat:*),Bash(head:*),Bash(tail:*),Bash(curl:*),Bash(sleep:*),Bash(tasklist:*),Bash(rm:*),Bash(cp:*),Bash(mv:*),Bash(echo:*),Bash(cd:*),Bash(timeout:*)'
Write-Host "Claude Code on $Brief -> logs\$Log.log" -ForegroundColor Cyan
& C:\Users\ericm\.local\bin\claude.exe -p $prompt --permission-mode acceptEdits --allowedTools $tools --output-format stream-json --verbose 2>&1 |
  ForEach-Object { $_ | Add-Content "logs\$Log.jsonl"; try { $j = $_ | ConvertFrom-Json; if ($j.type -eq 'assistant') { foreach ($c in $j.message.content) { if ($c.type -eq 'text') { $c.text } elseif ($c.type -eq 'tool_use') { '>> ' + $c.name + ' ' + (($c.input | ConvertTo-Json -Compress -Depth 3) -replace '(.{200}).*','$1...') } } } elseif ($j.type -eq 'result') { '=== RESULT ==='; $j.result } } catch { $_ } } | Tee-Object -FilePath "logs\$Log.log" -Append
Write-Host "Claude finished." -ForegroundColor Green

