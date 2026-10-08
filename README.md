# Piano-Tile

Transforme un enregistrement de piano en **tutoriel à notes tombantes**, façon Synthesia.

**En ligne : https://yasinmihci.github.io/Piano-Tile/**

- Dépose un fichier audio (MP3, WAV, M4A, FLAC, OGG) : la transcription par IA ([basic-pitch](https://github.com/spotify/basic-pitch) de Spotify, sur TensorFlow.js) tourne **dans le navigateur**, sans serveur.
- Les notes tombent sur un clavier de 88 touches, synchronisées avec l'audio d'origine : vitesse réglable (0,5× à 1,25×), compensation de latence, noms des notes, couleurs main droite / main gauche.
- Export **MIDI** avec une piste par main, importable dans Synthesia, un DAW ou MuseScore.
- Bouton de démo (début de la *Lettre à Élise*) : le morceau est joué avec des échantillons de piano, transcrit, puis comparé à la partition. Avec les réglages par défaut, 53 notes sur 53 sont retrouvées.

## Structure

```
docs/       site statique publié par GitHub Pages (aucune étape de build)
  index.html, style.css
  js/app.js          interface, lecture, orchestration
  js/transcriber.js  décodage audio, basic-pitch, nettoyage des notes, export MIDI
  js/player.js       rendu canvas : notes tombantes + clavier
  js/demo.js         démo Lettre à Élise (échantillons Salamander Grand Piano)
backend/    API FastAPI optionnelle : liens YouTube + modèle piano ByteDance (plus précis)
```

## Lancer le site en local

Les modules ES doivent être servis en HTTP (pas en `file://`) :

```bash
cd docs
python -m http.server 8765
```

puis ouvrir http://localhost:8765.

## Serveur optionnel (YouTube + modèle piano)

Une page statique ne peut pas télécharger depuis YouTube. Le dossier `backend/` fournit une API FastAPI qui :

1. télécharge l'audio avec `yt-dlp` puis le convertit avec `ffmpeg` ;
2. le transcrit avec [`piano_transcription_inference`](https://github.com/qiuqiangkong/piano_transcription_inference) (ByteDance, F1 ≈ 96,8 % sur les attaques de notes du jeu de données MAESTRO) ;
3. renvoie les notes au site, qui les affiche avec le même lecteur.

**En local sous Windows** (procédure testée sous Windows 11, PowerShell, à faire une seule fois) :

```powershell
# 1. Python 3.11 et ffmpeg (rouvrir le terminal ensuite pour que le PATH soit à jour)
winget install --id Python.Python.3.11 -e
winget install --id Gyan.FFmpeg -e

# 2. Environnement virtuel + dépendances (PyTorch CPU ; avec une carte NVIDIA, prendre l'index cu12x de pytorch.org)
cd backend
py -3.11 -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\pip install -r requirements.txt

# 3. Poids du modèle (~172 Mo) : le téléchargement automatique du package dépend de wget, absent sous Windows
$d = "$HOME\piano_transcription_inference_data"
New-Item -ItemType Directory -Force $d
curl.exe -L -o "$d\note_F1=0.9677_pedal_F1=0.9186.pth" "https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"
```

**À chaque utilisation** : double-cliquer sur `backend\start.cmd` (ou lancer `backend\start.ps1`). Le script active le venv, définit `PIANO_CHECKPOINT` (chemin ci-dessus par défaut) et démarre l'API sur http://localhost:8000. Garder la fenêtre ouverte pendant l'utilisation. Sur le site, ouvrir **Paramètres** et renseigner `http://localhost:8000` comme URL de l'API.

Chrome demande la première fois l'autorisation d'**accéder aux appareils du réseau local** pour yasinmihci.github.io : cliquer sur **Autoriser**. En cas de refus, la permission se rétablit via l'icône à gauche de l'adresse → Paramètres du site → « Réseau local » → Autoriser. Sur CPU, compter environ 1,5 s de calcul par seconde de musique.

**Hébergé** : `backend/Dockerfile` est prêt pour un Space Hugging Face (SDK Docker, port 7860). Les origines CORS autorisées se règlent avec `ALLOWED_ORIGINS`. Attention : YouTube bloque souvent les adresses IP des datacenters, donc les liens YouTube fonctionnent mieux avec le serveur lancé en local.

## Limites

- Les accords denses, la pédale de sustain et la réverbération provoquent des fausses notes et des erreurs d'octave. Le filtre « octaves fantômes » (activé par défaut) en retire une bonne partie.
- Les meilleurs résultats viennent d'un piano seul, enregistré proprement. Avec d'autres instruments ou du chant, la transcription se dégrade fortement.
- La répartition des mains est une approximation (coupure au Do central).
- Télécharger depuis YouTube peut enfreindre ses conditions d'utilisation et le droit d'auteur : à réserver à un usage personnel ou à des contenus dont tu as les droits.

## Crédits

Modèle basic-pitch : Spotify, Apache-2.0. Échantillons de la démo : Salamander Grand Piano par Alexander Holm, CC-BY 3.0, hébergés par Tone.js.
