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
- création d'un index sémantique local à partir des PDF OCRisés ;
- questions au LLM avec affichage des extraits sources ;
- import récursif de tous les PDF d'un dossier ;
- progression globale, pause, reprise et relance des échecs ;
- sélection et reprise des projets créés précédemment ;
- détection côté serveur des PDF identiques déjà traités ;
- import de PDF, textes, fichiers Office, courriels EML et images ;
- citations par page et recherche hybride ;
- prévisualisation modifiable du classement proposé ;
- copie validée vers un dossier séparé, sans toucher aux originaux ;
- résolution des conflits de noms et annulation contrôlée par empreinte SHA-256.
- estimation des tokens et du coût avant confirmation de l'indexation ;
- suivi d'une indexation persistante en arrière-plan et relance après échec ;
- création manuelle d'une sauvegarde ZIP des métadonnées du serveur ;
- tableau de bord moderne avec navigation par projet ;
- bibliothèque documentaire avec recherche et filtres par catégorie ;
- filtrage des relations détectées entre documents (organisme, personne, catégorie et année) ;
- assistant conversationnel isolé par projet ;
- espace d'ajout guidé pour un dossier complet ou un document individuel ;
- menu de projet permettant de renommer, supprimer ou ouvrir le dossier source ;
- suppression limitée aux données ClairDoc, sans toucher aux fichiers originaux ;
- mode sombre persistant ;
- page de paramètres détaillant les modèles IA, l'OCR, le stockage et les limites ;
- cartographie en arbre avec filtres par recherche, document et type de relation ;
- catégories de l'arbre repliables et ouverture d'un document par clic ;
- choix persistant du modèle de réponse entre Luna, Terra et Sol ;
- adresse du serveur affichée en lecture seule dans l'interface ;
- validation d'une architecture en mode copie ou déplacement sécurisé ;
- utilisation automatique du PDF OCRisé dans l'architecture validée ;
- aucun déplacement des originaux sans sélection explicite du mode correspondant et confirmation ; un PDF n'est envoyé au serveur qu'après une action explicite.

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

En développement, vous pouvez éviter la saisie manuelle :

```bash
cp .env.example .env
# Renseignez CLAIRDOC_API_KEY avec la même valeur que sur le serveur.
npm run tauri dev
```

Ces variables sont lues par le backend Rust et ne portent pas le préfixe `VITE_` : elles ne sont donc pas intégrées au JavaScript. Le fichier `.env` est ignoré par Git. Dans une application installée, la configuration enregistrée dans le dossier de données de l'application reste le mécanisme normal.

La clé OpenAI ne doit pas être placée ici. `OPENAI_API_KEY` appartient exclusivement au fichier `.env` de ClairDoc Server.

Le mode « Copier » reste le comportement par défaut et préserve tous les originaux. Le mode « Déplacer et nettoyer » nécessite une confirmation supplémentaire : il écrit et vérifie la nouvelle architecture, conserve une sauvegarde de sécurité dans `.clairdoc/originals`, puis retire les anciens fichiers de leur emplacement source. Les PDF classés sont les versions OCRisées produites par le serveur ; les autres formats restent dans leur format natif.

Par défaut, utilisez `http://127.0.0.1:8787` lorsque les deux programmes fonctionnent dans la même instance WSL. Si le serveur fonctionne sur une autre machine, utilisez son adresse privée et configurez `CLAIRDOC_HOST=0.0.0.0` côté serveur. N'exposez pas directement l'API sur Internet.

Avant la création des embeddings, l'application affiche une estimation indicative du nombre de tokens et du coût. L'utilisateur doit confirmer explicitement. Le serveur traite ensuite l'indexation dans une tâche persistante : fermer l'application Tauri n'annule donc pas le travail. Le bouton « Sauvegarder les métadonnées » archive projets, index, textes extraits, plans et historique des tâches sans dupliquer les PDF volumineux.
