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

& "$PSScriptRoot\.venv\Scripts\Activate.ps1"
python -m uvicorn app.main:app --port 8000
