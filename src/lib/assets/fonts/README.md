# Polices du journal

Caveat, DM Sans et Fraunces sont incluses dans le dépôt et servies depuis le même site que le journal, en développement comme en production. `src/app.css` importe les déclarations `@font-face` locales ; Vite publie les fichiers WOFF2 avec une empreinte dans leur nom. Le sous-ensemble latin de Caveat est préchargé dans les versions Node et PHP.

Les variantes et graisses reprennent la requête Google Fonts d’origine. `sources.json` enregistre la feuille source, les URL des fichiers et leurs empreintes SHA-256. Les licences SIL Open Font License sont fournies dans `static/assets/font-licenses/` et publiées avec les assets.

Aucune requête Google Fonts n’est nécessaire à l’affichage du site. Une mise à jour doit conserver les graisses et axes demandés pour ne pas modifier la mise en page.
