# Lance l'API Piano-Tile sur http://localhost:8000
# Usage : .\start.ps1  (ou double-clic sur start.cmd)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# PATH à jour (ffmpeg installé par winget) même si la console a été ouverte avant l'installation
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")

if (-not $env:PIANO_CHECKPOINT) {
    $env:PIANO_CHECKPOINT = Join-Path $HOME "piano_transcription_inference_data\note_F1=0.9677_pedal_F1=0.9186.pth"
}
if (-not (Test-Path $env:PIANO_CHECKPOINT)) {
    Write-Error "Poids du modèle introuvables : $env:PIANO_CHECKPOINT (voir README, section serveur)"
}

$busy = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($busy.OwningProcess)"
    if ($proc.CommandLine -match "uvicorn") {
        Write-Host "Le serveur Piano-Tile tourne déjà sur http://localhost:8000 (PID $($proc.ProcessId)) : rien à faire."
        Write-Host "Pour le redémarrer : Stop-Process -Id $($proc.ProcessId), puis relancer ce script."
        exit 0
    }
    Write-Error "Le port 8000 est occupé par un autre programme : $($proc.Name) (PID $($proc.ProcessId))."
}

& "$PSScriptRoot\.venv\Scripts\Activate.ps1"
python -m uvicorn app.main:app --port 8000
