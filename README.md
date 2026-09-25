# ClairDoc

Application de bureau destinée à aider les utilisateurs à inventorier, rechercher et organiser leurs documents administratifs sans modifier les originaux.

## Première étape disponible

- sélection native d'un dossier ;
- analyse récursive en lecture seule ;
- comptage des fichiers, sous-dossiers, PDF, images et documents bureautiques ;
- aucun déplacement, renommage ou envoi réseau.

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

L'application analyse actuellement un dossier local en lecture seule. Elle n'appelle pas encore ClairDoc Server. La prochaine étape consiste à ajouter la configuration de l'adresse du serveur et de la clé `CLAIRDOC_API_KEY`, puis l'envoi des PDF et le suivi des travaux OCR depuis l'interface.

