# SereTiny

## Hébergement mutualisé Apache / PHP

Le site dispose aussi d’un backend **PHP 8.4**, utilisable sans Node sur le serveur. La même interface **Svelte 5** est compilée localement ; PHP assure SQLite, l’authentification, les formulaires, les commentaires, les images WebP et Google Photos. Le déploiement Node/Docker reste disponible.

```bash
npm run check:php
npm run build:php
```

Le dossier `dist-php/` est le paquet à publier. Son chemin public est `/seretiny` par défaut ; définir `SERETINY_BASE_PATH` avant la compilation pour le changer. Les URL de l’interface, des médias et des textures sont adaptées à ce sous-dossier.

Les polices Caveat, DM Sans et Fraunces sont incluses et servies localement dans les deux versions, avec préchargement de Caveat. L’affichage ne dépend pas d’une connexion à Google Fonts ; les licences sont publiées dans `assets/font-licenses/`.

Le serveur doit fournir PHP 8.4 avec PDO SQLite, GD (WebP et AVIF), EXIF, mbstring, OpenSSL et cURL. FFmpeg et ffprobe sont nécessaires aux vidéos ; ils peuvent être installés dans `.private/bin/` sans droits administrateur. Les photos sont limitées à 12 Mo et 24 mégapixels pour respecter la mémoire du mutualisé ; les vidéos à 100 Mo et 10 minutes. `php.ini` demande une limite de 120 Mo par requête, sous réserve des plafonds de l’hébergeur.

La configuration privée se place dans `dist-php/.private/.env` sur le serveur : mêmes secrets que `.env.example`, avec `SITE_URL=https://ton-domaine/seretiny`, un `DATA_DIR` absolu, et les chemins Linux de FFmpeg/ffprobe. Le fichier `.htaccess` fourni interdit l’accès HTTP à `.private/`, `server/` et aux fichiers cachés. Ne pas retirer cette protection. Sélectionner PHP 8.4 dans le panneau de l’hébergeur ; l’application utilise son gestionnaire PHP par défaut.

Les outils suivants lisent les identifiants du fichier **non versionné** `.vscode/ssh.json` (`host`, `port`, `username`, `password` ou `privateKeyPath`, `remotePath` absolu côté SSH et `siteUrl`). Python et Paramiko sont requis sur le poste de déploiement.

```bash
# Tests HTTP sur une copie isolée : ne touchent pas la base publique.
npm run test:php

# Premier déploiement : sauvegarde SQLite cohérente + originaux et dérivés.
node --env-file-if-exists=.env scripts/export-php-data.mjs
python scripts/remote-php.py init

# Déployer le paquet compilé, en conservant la configuration et les données.
python scripts/remote-php.py deploy
```

`init` préserve une base et un `.env` déjà présents. `deploy` sauvegarde la base SQLite et les fichiers applicatifs dans `.private/backups/`, conserve les anciens assets pour les pages déjà ouvertes, et ne supprime ni photos ni originaux. Les clés SSH connues sont mémorisées localement dans `.vscode/ssh-known-hosts` ; une clé modifiée est refusée.

L’import local propose aujourd’hui, une journée existante, une date libre ou le regroupement par date de prise de vue. La date d’affichage reste indépendante des métadonnées.

Pour Google Photos, ajouter **`https://ton-domaine/seretiny/admin/google-photos/callback`** aux URI autorisées du client OAuth Google. Les accès et la progression sont chiffrés en AES-256-GCM dans une table additive `php_google_flows` (migration `005-php-support`). L’import traite un fichier par requête de suivi : garder l’administration ouverte pour le faire avancer. Fermer la page suspend le traitement ; revenir dans l’atelier le reprend. Aucune synchronisation de photothèque n’est effectuée.

Les tests PHP vérifient connexion et CSRF, transactions, chapitres, import et déplacement, dédoublonnage, visibilité des médias, lecture HTTP Range, commentaires et modération. Les appels Google sont simulés pour vérifier chiffrement, renouvellement, reprise et validation des URL ; l’autorisation réelle nécessite la configuration du client Google.

**Journal de construction immersif d'une tiny house — Svelte 5 + SvelteKit 3.**

Projet personnel autonome, en français (anglais en option), conçu pour un VPS Linux. Les photos s'importent depuis l'ordinateur ou, en option, par sélection directe dans Google Photos. Elles restent stockées sur le VPS ; aucun compte Google n'est requis pour l'import local.

## Démarrage en local

**Prérequis :** Node.js **22.17 ou plus récent**, npm, et **FFmpeg avec ffprobe** pour importer des vidéos et exécuter les tests vidéo. Les dépendances natives (`better-sqlite3` et `sharp`) peuvent nécessiter des outils de compilation sur certaines machines. Docker est facultatif.

```bash
# Après avoir décompressé l'archive :
cd seretiny
npm install
cp .env.example .env
```

Dans `.env`, remplacer **obligatoirement** `ADMIN_PASSWORD` par une phrase secrète robuste et `SESSION_SECRET` par un secret aléatoire, par exemple :

```bash
openssl rand -hex 32
```

Puis :

```bash
npm run dev
```

- Site public : **http://localhost:5173**
- Espace privé : **http://localhost:5173/admin/login**

Le mot de passe doit contenir au moins **12 caractères** et `SESSION_SECRET` au moins **32 caractères**. Après une modification de `.env`, redémarrer le serveur de développement. Ces variables sont lues côté serveur via les variables privées de SvelteKit.

Le dossier `data/` est créé automatiquement à la première requête : base SQLite, photos originales et images optimisées. Il est ignoré par Git : **ne pas le supprimer si tu as des données importantes**.

## Organisation de l’atelier

Le menu de `/admin` propose cinq vues : **Journées**, **Photothèque**, **Chapitres**, **Importer** et **Commentaires**. Sur mobile, le menu défile horizontalement.

- **Journées** : recherche, filtres par chapitre, dates et affichage, puis ouverture d’une fiche pour éditer le récit et les photos. La sélection permet d’activer ou de masquer plusieurs journées ensemble.
- **Photothèque** : grille ou liste, recherche et filtres. Un simple clic sur la légende française ou la date ouvre son édition, avec **Enregistrer**, **Annuler** et la touche Échap. Cliquer sur l’image ouvre un aperçu en grand ; le crayon en haut à droite ouvre la fiche complète. Chaque photo dispose d’un bouton de suppression avec confirmation.
- **Édition en lot** : cocher les photos, puis choisir les champs à modifier : date d’affichage et/ou légendes française et anglaise. Seuls les champs cochés sont remplacés ; une légende cochée et vide efface sa valeur. Les sélections restent disponibles entre les pages de résultats et sont effacées quand les filtres changent. Chaque lot accepte jusqu’à 500 éléments et est appliqué dans une transaction SQLite.
- **Chapitres** : édition des noms et dates de début, avec rattachement automatique des journées selon leurs dates.
- **Commentaires** : approbation ou suppression individuelle, ou traitement d’une sélection.

Déplacer des photos vers une nouvelle date crée une journée avec affichage activé. Les récits des anciennes journées sont conservés. Les photos déplacées vers une journée publiée deviennent visibles sur le site.

## Publication d'une journée

1. Ouvrir `/admin/login`, se connecter avec le mot de passe configuré.
2. Ouvrir **Importer**, puis **Des photos aux journées**, pour importer 1 à 8 photos à la fois (JPG, PNG, WebP ou AVIF, **12 Mo maximum par photo**). Leur date de prise de vue EXIF (`DateTimeOriginal`, ou à défaut `DateTimeDigitized`) regroupe les photos par journée, en conservant le jour local de l'appareil. Les journées manquantes sont créées avec **l’affichage sur le site activé** ; celles qui existent sont réutilisées sans modifier leurs textes ni leur publication. Les chapitres sont déterminés par leurs dates de début. Les photos ajoutées à une journée déjà publiée deviennent donc visibles.
3. Si une photo n'a pas de date de prise de vue lisible, renseigner une **date de remplacement** facultative ; sinon elle est ignorée et signalée. Les dates de modification du fichier et d'import ne sont pas utilisées. Un bilan précise les imports réussis et les éventuelles erreurs : en cas d'import partiel, réessayer uniquement les images signalées. Il reste possible de créer une journée manuellement depuis **Journées → Créer une journée**, puis d'importer des photos directement dans sa fiche.
4. Compléter la **légende française** de chaque photo (et la version anglaise, facultative). Modifier sa **date d'affichage** pour la déplacer vers une autre journée. Si la nouvelle date n'existe pas, une journée avec affichage activé est créée.
5. Rédiger le **récit de la journée**, son titre et ses éventuelles traductions. Son chapitre est déterminé automatiquement par sa date.
6. **Afficher cette journée sur le site** est coché par défaut. Enregistrer les modifications ; décocher cette case pour masquer une journée. Une journée vide reste absente du site jusqu’à l’ajout d’une photo.
7. Modérer les commentaires depuis la partie **Commentaires** de l'atelier.

Les photos originales restent privées dans `data/originals/`. Le site public sert des versions WebP, recadrées pour les miniatures et redimensionnées pour les grandes images. Les photos des journées masquées ne sont pas accessibles sans authentification.

## Photos et vidéos

Les mêmes formulaires acceptent aussi les **MP4, MOV et WebM**, jusqu’à **100 Mo et 10 minutes par vidéo**, avec 1 à 8 fichiers et **120 Mo au total par envoi**. Chaque vidéo possède sa légende, sa date d’affichage éditable et sa miniature. Photos et vidéos sont classées ensemble par date et heure de prise de vue ; la date d’affichage sert de repli si cette information manque.

La lecture utilise le lecteur **`<video>` natif du navigateur**, avec son, commandes, lecture intégrée et plein écran. Elle démarre uniquement à la demande et le diaporama ne passe pas automatiquement au média suivant pendant une vidéo. Ouvrir une fenêtre du journal ou changer de média arrête la lecture en cours.

**Docker n’est pas nécessaire à la lecture ni à l’installation.** [FFmpeg](https://ffmpeg.org/download.html) et ffprobe servent côté serveur à vérifier les vidéos, lire leurs métadonnées et créer les miniatures. Les MP4 H.264 avec audio AAC/MP3 sont préparés pour une lecture progressive **sans réencodage** ; les autres codecs sont convertis en MP4 H.264/AAC. Les originaux sont conservés dans `data/originals/`, et les versions de lecture dans `data/media/`. La route vidéo gère les requêtes HTTP Range pour avancer dans le film, avec les mêmes contrôles d’accès que les photos.

Sur Debian/Ubuntu sans Docker : `sudo apt-get install ffmpeg`. Sous Windows : `winget install --id Gyan.FFmpeg.Essentials --exact`, puis rouvrir le terminal et redémarrer le serveur de développement. Si nécessaire, définir `FFMPEG_PATH` et `FFPROBE_PATH` dans `.env` avec les chemins absolus des exécutables. Le conteneur existant inclut ces outils.

Les dates QuickTime locales sont conservées ; les dates vidéo UTC sont converties dans `GOOGLE_PHOTOS_TIME_ZONE`. Les vidéos sans date nécessitent la date de remplacement pour le regroupement automatique, ou peuvent être importées directement dans une journée. La migration additive `004-video-media` attribue le type photo aux contenus existants, sans modifier les dates, récits et légendes.

Dans **Les chapitres**, définir une **date de début** unique pour chaque chapitre. Ils sont classés chronologiquement : un chapitre couvre sa date de début incluse jusqu'au début du suivant exclu. Le dernier reste ouvert ; les journées antérieures au premier restent sans chapitre. Modifier une date de chapitre, de journée ou de photo actualise automatiquement ce rattachement.

La migration SQLite vers `user_version = 2` reprend la première journée associée à chaque chapitre comme date de début, en préservant les contenus existants. Les chapitres sans journée restent à dater dans l'atelier.

> Le site public démarre volontairement **vide** : aucun faux contenu n'est publié à ta place. Trois chapitres par défaut servent de point de départ et peuvent être renommés ; renseigner leurs dates de début pour les utiliser.

## Import depuis Google Photos (optionnel)

Cet import utilise [Google Photos Picker](https://developers.google.com/photos/picker/guides/get-started-picker) : tu choisis les images à partager avec SereTiny dans Google Photos, puis tu lances leur import depuis l'atelier. Il n'y a pas de synchronisation en arrière-plan ni d'accès à toute la photothèque.

1. Dans un projet [Google Cloud Console](https://console.cloud.google.com/), activer **Google Photos Picker API**, configurer l'écran de consentement OAuth et ajouter ton compte aux utilisateurs de test si l'application est en mode test.
2. Créer un **client OAuth de type Application Web**. Ajouter l'URI de redirection exacte : `http://localhost:5173/admin/google-photos/callback` en développement, et `https://ton-domaine/admin/google-photos/callback` sur le VPS. Suivre la [configuration officielle](https://developers.google.com/photos/overview/configure-your-app).
3. Renseigner dans `.env` les variables ci-dessous, puis redémarrer le serveur ou recréer le conteneur. Le client secret reste exclusivement côté serveur.

```dotenv
GOOGLE_PHOTOS_CLIENT_ID=ton-client.apps.googleusercontent.com
GOOGLE_PHOTOS_CLIENT_SECRET=ton-secret
GOOGLE_PHOTOS_REDIRECT_URI=http://localhost:5173/admin/google-photos/callback
GOOGLE_PHOTOS_TIME_ZONE=Europe/Paris
```

4. Dans l'atelier, cliquer **Choisir dans Google Photos**, autoriser l'accès demandé, ouvrir la sélection Google et choisir les photos et vidéos souhaitées : SereTiny n'ajoute aucune limite au sélecteur (Google autorise jusqu'à **2 000 éléments** par sélection). Valider dans Google, revenir à SereTiny puis cliquer **Importer la sélection**. L'import se poursuit en arrière-plan, un fichier à la fois, avec une progression et un bilan dans l'atelier. Tu peux recharger la page pendant le traitement. Les fichiers hors des formats ou limites acceptés sont signalés. Les vidéos doivent avoir terminé leur traitement chez Google ; elles sont téléchargées via le paramètre `dv` documenté dans [Google Photos Picker](https://developers.google.com/photos/picker/guides/media-items).

Les journées utilisent la date EXIF locale ; à défaut, la date de création fournie par Google est convertie dans `GOOGLE_PHOTOS_TIME_ZONE` (Europe/Paris par défaut). Une date de remplacement facultative couvre les images sans date exploitable. Les journées nouvelles sont visibles dès l’import ; les journées existantes conservent leurs textes et leur statut.

Les doublons sont reconnus par l'**identifiant Google persistant** et l'**empreinte SHA-256 du fichier**, quel que soit son nom ou sa date d'affichage actuelle. Les originaux déjà présents sont indexés au premier nouvel import. La détection par empreinte fonctionne aussi pour les imports locaux ; une version réencodée ou dont les métadonnées ont changé peut avoir une empreinte différente. Les légendes et déplacements éditoriaux sont conservés lors d'un réimport ignoré. Supprimer une photo retire aussi ses références d'import et permet de la réimporter.

La connexion Google est mémorisée pour ce navigateur pendant **30 jours**, avec renouvellement automatique du jeton d'accès. Après un import, **Choisir dans Google Photos** ou **Nouvelle sélection** réutilise le compte connecté ; rafraîchir l'administration ne relance pas l'autorisation Google. La première connexion demande une autorisation d'accès hors ligne ; si tu utilisais l'ancienne version, reconnecter une fois pour l'activer. **Changer de compte Google** ouvre explicitement le choix du compte. **Déconnecter Google Photos** efface la connexion enregistrée. La déconnexion de l'atelier conserve cette préférence ; l'accès à Google reste réservé à l'administration authentifiée dans ce navigateur.

Les jetons et la sélection active sont enregistrés dans SQLite avec un chiffrement **AES-256-GCM**, dont la clé dépend de `SESSION_SECRET`. Aucun jeton n'est transmis au navigateur, uniquement un identifiant aléatoire dans un cookie HTTP-only. Conserver `SESSION_SECRET` lors d'un redéploiement ; le changer invalide les connexions enregistrées. La migration additive `002-google-connections` crée leur table sans modifier les photos. La connexion et la sélection survivent à un redémarrage du serveur. Un import en cours est interrompu par un redémarrage ; il peut être relancé en ignorant les photos déjà enregistrées. Les changements de code en développement conservent aussi la connexion en mémoire.

Une sélection réussie est fermée automatiquement, tout en gardant le compte connecté. En cas d'import partiel, réessayer la même sélection ignore les photos déjà enregistrées et retente les autres. Le bilan affiche les compteurs complets et au maximum les 20 premières erreurs. Si Google révoque l'autorisation, reconnecter le compte. Avec un écran de consentement **Testing**, Google peut faire expirer le jeton de renouvellement après **7 jours** : cette limite ne dépend pas de SereTiny. Voir la [documentation OAuth Google](https://developers.google.com/identity/protocols/oauth2#expiration).

Chaque téléchargement dispose de **120 secondes**, avec au maximum **3 tentatives** en cas de coupure ou de délai réseau dépassé (attentes de 0,5 puis 1 seconde). Les lectures des métadonnées disposent de 30 secondes par tentative. Les erreurs pendant la réception des fichiers sont gérées comme celles survenant à la connexion ; les octets partiels sont abandonnés avant une nouvelle tentative. Une photo qui échoue reste signalée dans le bilan et l'import passe à la suivante. Les fichiers trop volumineux, les erreurs de certificat et les refus HTTP ne sont pas retentés automatiquement.

La migration additive `001-photo-sources`, suivie dans `schema_migrations`, crée les références de dédoublonnage sans modifier les journées, les photos ou leurs légendes. Elle est indépendante des migrations de chapitres suivies par `PRAGMA user_version`.

Validation : `npm run check` puis `npm test`. Les tests utilisent une base et des photos temporaires ainsi qu'une simulation de Google ; ils ne contactent aucun compte Google réel. La connexion réelle nécessite tes identifiants OAuth.

Si l’atelier signale une impossibilité de joindre Google, vérifier la connexion sortante du serveur (DNS, proxy, pare-feu, certificats TLS). L’échange OAuth utilise `oauth2.googleapis.com/token` ; si ce serveur ne peut pas être joint, SereTiny essaie aussi l’[endpoint OAuth officiel de compatibilité](https://developers.google.com/nest/device-access/authorize) `www.googleapis.com/oauth2/v4/token`. Un refus OAuth HTTP ou une erreur de certificat ne déclenche pas ce secours. Les messages distinguent la connexion OAuth, la sélection et le téléchargement sans exposer les secrets.

## Navigation du site public

- **Molette / trackpad** : avance ou recule d'une journée.
- **Frise en bas** : faire glisser horizontalement à la souris, ou cliquer sur une date.
- **Flèches gauche / droite** : navigation clavier entre les journées.
- **Miniatures et flèches autour de l'image** : photos de la même journée.
- **Téléphone / écran tactile** : miniatures sur une seule rangée horizontale avec la photo sélectionnée gardée en vue ; compteur intégré et espace libéré pour l’image principale. Pas de diaporama automatique ni de barre lecture/précédent/suivant. La date au-dessus du titre et les commandes précédent/suivant des journées sont masquées ; la frise tactile sert à choisir une journée. L’affichage sur ordinateur conserve ses commandes.
- **FR / EN** : interface bilingue ; les contenus sans traduction retombent sur la version française.
- **Commentaires** : formulaire public avec validation préalable. Aucun compte visiteur requis.
- **Lien direct** : `https://ton-domaine/#2026-10-20` ouvre cette journée si elle est publiée.

L'expérience principale fait 100 % de la hauteur de l'écran, sans scroll vertical ; seules les fenêtres d'édition de récit et de commentaires peuvent défiler si nécessaire.

## Déploiement simple sur VPS (Docker Compose)

Prévoir un VPS Linux avec Docker et le plugin Docker Compose, ainsi qu'un nom de domaine pointant vers le serveur.

```bash
cp .env.example .env
# Modifier ADMIN_PASSWORD et SESSION_SECRET dans .env (ne jamais les committer)
docker compose up -d --build
docker compose logs -f seretiny
```

Le conteneur écoute **uniquement sur `127.0.0.1:3000`** côté VPS (sécurité). Il faut ensuite faire passer ton domaine par un reverse proxy HTTPS (Caddy ou Nginx). Exemple de configuration Caddy : `Caddyfile.example`. En production, ne pas exposer directement le port 3000 à Internet.

Les données sont conservées dans le volume Docker **`seretiny_data`**. Si tu mets le conteneur à jour, conserve ce volume et sauvegarde-le régulièrement. SQLite fonctionne en WAL : pour une sauvegarde fiable à chaud, utilise l'outil de sauvegarde SQLite ou coupe brièvement le conteneur avant de copier les fichiers.

Dans `compose.yaml`, `PROTOCOL_HEADER`, `HOST_HEADER` et `ADDRESS_HEADER` sont utilisés pour un reverse proxy **fiable**. Ne jamais activer la confiance dans ces en-têtes sur un port directement exposé à Internet.

### Démarrage sans Docker

```bash
npm install
npm run check
npm run build
NODE_ENV=production PORT=3000 npm run start
```

`npm run start` charge le fichier `.env` s'il existe ; les variables déjà définies dans l'environnement du serveur restent prioritaires. En production, accéder à l'administration via HTTPS pour que le cookie sécurisé soit accepté.

L'applicatif Node doit rester actif avec un service (`systemd`, par exemple). Définir `DATA_DIR` vers un dossier persistant et le protéger dans les permissions système.

## Architecture

```text
src/
  routes/
    +page.svelte                 # journal public et timeline animée
    +page.server.ts              # charge les journées publiées
    admin/
      +page.svelte               # administration éditoriale
      +page.server.ts            # actions d'édition/import/modération
      login/                     # connexion administrateur
    api/comments/+server.ts      # commentaire public / antispam minimal
    media/[id]/[variant]/        # images filtrées selon leur visibilité
  lib/server/
    db.ts                       # SQLite, requêtes et gestion des chapitres
    auth.ts                     # session admin signée
    images.ts                   # traitement Sharp des images
  lib/types.ts                  # types des entités
data/                           # créé à l'exécution, jamais dans Git
  seretiny.sqlite
  media/                        # WebP optimisés
  originals/                    # fichiers originaux privés
```

### Choix techniques

- **Svelte 5** avec les *runes* (`$state`, `$derived`, `$props`).
- **SvelteKit 3**, routeur et form actions côté serveur.
- **SQLite / better-sqlite3**, structure volontairement simple pour un site personnel.
- **Sharp** pour convertir, redimensionner et alléger les photos.
- **Node adapter** pour un VPS, **Docker Compose** en option.
- **CSS natif** pour une identité visuelle bois/cuivre/crème, sans dépendance CSS supplémentaire.
- **Import à la demande** depuis le disque ou Google Photos Picker, sans synchronisation automatique.

## Sécurité et limites de cette base

- Authentification **mono-administrateur** par phrase secrète dans l'environnement ; cookie de session signé HTTP-only, valide 7 jours. HTTPS indispensable en production.
- Commentaires en **attente de validation** ; piège anti-spam et limite de 3 messages/heure/adresse IP (méthode volontairement simple). Pour un trafic important, ajouter une solution anti-spam et une protection contre le bruteforce du login.
- Images : format réel validé par Sharp et limites de taille ; aucun upload SVG exécutable.
- Pas de restauration des anciennes versions, pas de rôles multi-utilisateurs et pas d'import automatique Google Photos.
- Les traductions des textes et légendes sont **manuelles** ; l'anglais n'est pas généré automatiquement.
- **HEIC/HEIF non inclus** dans les formats validés : convertir en JPG avant import (ou implémenter le support selon la build Sharp).
- La base a été créée comme **socle de développement**, pas comme produit testé en charge : vérifier `npm run check`, tester le parcours complet et mettre en place une sauvegarde avant mise en production.

## Prochaines évolutions possibles

- Import par glisser-déposer, prévisualisation et légendes saisies avant validation.
- Réorganisation visuelle des photos par glisser-déposer.
- Affichage des périodes des chapitres comme bandes sur la timeline.
- Recherche par mots-clés, pagination des anciennes photos si la bibliothèque grossit.
- Accélération et navigation tactile fine, animations adaptées aux petits écrans.
- Notifications e-mail optionnelles pour les commentaires à modérer.
- Génération automatique de traductions FR/EN facultative et révisable.
- Tests automatisés d'intégration et de sécurité.

**Pour reprendre avec un assistant de programmation :** ouvrir le dossier entier `seretiny/` dans VS Code ou ChatGPT Desktop et lui faire lire `README.md` puis `AGENTS.md`.
