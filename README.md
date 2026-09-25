# ClairDoc

Application de bureau destinée à aider les utilisateurs à inventorier, rechercher et organiser leurs documents administratifs sans modifier les originaux.

## Première étape disponible

- sélection native d'un dossier ;
- analyse récursive en lecture seule ;
- comptage des fichiers, sous-dossiers, PDF, images et documents bureautiques ;
- configuration et validation de ClairDoc Server ;
- création d'un projet sur le serveur ;
- envoi en flux d'un PDF vers OCRmyPDF ;
- suivi du travail OCR et affichage du texte extrait ;
- aucun déplacement ou renommage des originaux ; un PDF n'est envoyé au serveur qu'après une action explicite.

## Développement

Prérequis : WSL2 avec WSLg, Node.js, Rust et les bibliothèques Linux requises par Tauri.

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

npm ci
npm run tauri dev
```

WSLg est nécessaire pour afficher la fenêtre native depuis WSL. Les dossiers montés restent accessibles sous `/mnt/c`, mais les commandes de développement et de compilation doivent être lancées dans WSL.

Vérification du frontend :

```bash
npm run build
```

## État de l'intégration serveur

L'application communique avec ClairDoc Server depuis son backend Rust. Renseignez l'adresse du serveur et la même valeur `CLAIRDOC_API_KEY` que dans le fichier `.env` du serveur. La clé n'est jamais renvoyée au frontend après sa sauvegarde ; sous Linux, son fichier de configuration local est limité à l'utilisateur courant (`0600`).

Par défaut, utilisez `http://127.0.0.1:8787` lorsque les deux programmes fonctionnent dans la même instance WSL. Si le serveur fonctionne sur une autre machine, utilisez son adresse privée et configurez `CLAIRDOC_HOST=0.0.0.0` côté serveur. N'exposez pas directement l'API sur Internet.
