# Contexte de développement — SereTiny

Tu travailles sur **SereTiny**, journal photo personnel de construction d'une tiny house. L'utilisateur échange en **français**, demande **Svelte 5** et souhaite un déploiement sur son VPS.

## Intentions produit (à préserver)

- Interface publique **immersive, plein écran, sans défilement vertical** : voyage horizontal dans le temps (molette, clic, glisser, clavier).
- **Chapitres / ères** de construction identifiables sur la frise.
- Images de chaque journée animées, légendes distinctes par photo et texte associé à la journée.
- Ambiance atelier, outils et bois flous, palette bruns/lin/cuivre, typographie éditoriale.
- Traduction française et anglaise ; français prioritaire, anglais optionnel avec repli FR.
- **Import à la demande** depuis le disque ou Google Photos Picker ; pas de synchronisation automatique de la photothèque.
- Une date d'affichage éditable par photo, indépendante de son import et des autres photos.
- Visiteurs autorisés à commenter ; modération préalable.
- VPS auto-hébergé, simplicité de maintenance.

## Stack actuelle

Svelte 5 (runes), SvelteKit 3, TypeScript 6, Node 22.17+, SQLite/better-sqlite3, Sharp, adapter-node, Docker Compose. `vite.config.ts` porte la config SvelteKit 3. Alias interne `#lib/*` déclaré dans `package.json` (ne pas revenir à `$lib`).

## Repères

- `src/routes/+page.svelte` : public ; timeline, animations, langue, boîte de commentaires.
- `src/routes/admin/+page.svelte` : formulaires d'édition en actions SvelteKit natives.
- `src/routes/admin/+page.server.ts` : actions sécurisées pour créer/éditer/supprimer/importer/modérer.
- `src/lib/server/db.ts` : schéma et accès SQLite, ne jamais exposer sur le client.
- `src/lib/server/images.ts` : validation d'image, stockage de l'original et transformations WebP.
- `src/lib/server/google-photos.ts` : OAuth, connexion réutilisable et sélection Google Photos ; configuration `GOOGLE_PHOTOS_*` dans `.env`. `google-connection-store.ts` chiffre les accès persistés dans SQLite avec `SESSION_SECRET` ; aucun jeton côté client.
- `src/lib/server/auth.ts` : mot de passe et cookie signé.
- `src/routes/media/[id]/[variant]/+server.ts` : refus d'accès à une photo non publiée si visiteur anonyme.
- `data/` et `.env` ne sont pas versionnés ; **ne jamais supprimer** ces dossiers sans sauvegarde.

## Comment continuer

1. Installer les dépendances, configurer `.env` et lancer `npm run check`, `npm run dev`.
2. Vérifier l'import → légendes → déplacement de date → publication → navigation timeline → commentaire → modération.
3. Commencer par les bugs d'accessibilité/clavier et les adaptations tactiles, ensuite améliorer visuel et interactions.
4. Ajouter une migration SQL si le schéma change : migrations des chapitres via `PRAGMA user_version`, migrations additives `001-photo-sources` et `002-google-connections` via `schema_migrations`.
5. En production : HTTPS, restrictions réseau et sauvegarde SQLite + photos, puis protection anti-spam renforcée si le site reçoit plus de trafic.

Conserver une interface élégante, éviter les librairies superflues et ne pas mettre de clé secrète dans des modules `src/lib` importés côté client.
