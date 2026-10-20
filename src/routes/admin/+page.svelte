<script lang="ts">
  import type { PageData, ActionData } from './$types';
  import type { GoogleImportProgress } from '#lib/types.js';
  import { invalidateAll } from '$app/navigation';
  import { tick } from 'svelte';
  import LibraryPhoto from '#lib/components/admin/LibraryPhoto.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let selected = $derived(data.days.find((day) => day.id === data.selectedId));
  let publishedCount = $derived(data.days.filter((day) => day.published).length);
  let photoCount = $derived(data.days.reduce((total, day) => total + day.photos.length, 0));
  let search = $state('');
  let chapterFilter = $state('all');
  let statusFilter = $state('all');
  let fromDate = $state('');
  let toDate = $state('');
  let page = $state(1);
  let photoLayout = $state<'grid' | 'list'>('grid');
  let selectedDays = $state<string[]>([]);
  let selectedPhotos = $state<string[]>([]);
  let selectedComments = $state<string[]>([]);
  let changeDate = $state(false);
  let changeCaptionFr = $state(false);
  let changeCaptionEn = $state(false);
  let preview = $state<{id: string; caption: string} | null>(null);
  let previewDialog: HTMLDialogElement;

  async function openPreview(id: string, caption: string) {
    preview = {id, caption};
    await tick();
    previewDialog.showModal();
  }
  const pageSize = 24;
  const menu = [
    {id: 'days', title: 'Journées', icon: '▤', hint: 'Récits & publication'},
    {id: 'photos', title: 'Photothèque', icon: '▧', hint: 'Légendes & dates'},
    {id: 'chapters', title: 'Chapitres', icon: '≡', hint: 'Les étapes du chantier'},
    {id: 'imports', title: 'Importer', icon: '＋', hint: 'Disque & Google Photos'},
    {id: 'comments', title: 'Commentaires', icon: '◌', hint: 'Messages à modérer'}
  ];
  let filteredDays = $derived([...data.days].reverse().filter(day =>
    (chapterFilter === 'all' || String(day.chapter_id ?? 'none') === chapterFilter) &&
    (statusFilter === 'all' || (statusFilter === 'published' ? !!day.published : !day.published)) &&
    (!fromDate || day.date >= fromDate) && (!toDate || day.date <= toDate) &&
    (data.view === 'photos' || `${day.title_fr} ${day.title_en} ${day.body_fr} ${day.body_en} ${day.date}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr')))
  ));
  let filteredPhotos = $derived(filteredDays.flatMap(day => day.photos.map(photo => ({...photo, day}))).filter(photo =>
    `${photo.original_name} ${photo.caption_fr} ${photo.caption_en} ${photo.day.title_fr} ${photo.day.date}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr'))
  ).sort((a, b) => {
    const first = a.taken_at ?? `${a.day.date}T00:00:00.000`;
    const second = b.taken_at ?? `${b.day.date}T00:00:00.000`;
    return first < second ? -1 : first > second ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }));
  let total = $derived(data.view === 'photos' ? filteredPhotos.length : filteredDays.length);
  let pageCount = $derived(Math.max(1, Math.ceil(total / pageSize)));
  let currentPage = $derived(Math.min(page, pageCount));
  let visibleDays = $derived(filteredDays.slice((currentPage - 1) * pageSize, currentPage * pageSize));
  let visiblePhotos = $derived(filteredPhotos.slice((currentPage - 1) * pageSize, currentPage * pageSize));
  let visibleIds = $derived(data.view === 'photos' ? visiblePhotos.map(photo => photo.id) : visibleDays.map(day => String(day.id)));
  let selectedIds = $derived(data.view === 'photos' ? selectedPhotos : selectedDays);
  let allVisibleSelected = $derived(visibleIds.length > 0 && visibleIds.every(id => selectedIds.includes(id)));

  $effect(() => {
    // Selections belong to one view and one set of filters.
    void data; void search; void chapterFilter; void statusFilter; void fromDate; void toDate;
    selectedDays = []; selectedPhotos = []; selectedComments = []; page = 1;
  });

  function selectVisible(checked: boolean) {
    const next = checked ? [...new Set([...selectedIds, ...visibleIds])] : selectedIds.filter(id => !visibleIds.includes(id));
    if (data.view === 'photos') selectedPhotos = next; else selectedDays = next;
  }

  let googleReady = $state(false);
  let googleFeedback = $state('');
  let googleProgress = $state<GoogleImportProgress | null>(null);
  let shownGoogleProgress = $derived(googleProgress || data.googlePhotos.progress);
  let googleBusy = $derived(shownGoogleProgress?.status === 'running');

  $effect(() => {
    const connected = data.googlePhotos.connected;
    const pickerUri = data.googlePhotos.pickerUri;
    googleReady = data.googlePhotos.ready;
    googleProgress = data.googlePhotos.progress;
    googleFeedback = '';
    if (data.googlePhotos.progress?.status !== 'running' && (!connected || !pickerUri || data.googlePhotos.ready)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch('/admin/google-photos/status', {signal: controller.signal});
        const result = await response.json();
        if (stopped) return;
        if (!response.ok) {
          googleFeedback = result.message || 'Connexion Google Photos expirée.';
          if (googleProgress?.status === 'running') googleProgress = {...googleProgress, status: 'failed', message: googleFeedback};
          return;
        }
        googleReady = !!result.ready;
        googleProgress = result.progress || null;
        if (result.progress && result.progress.status !== 'running') { await invalidateAll(); return; }
        if (!googleReady || result.progress?.status === 'running') timer = setTimeout(poll, Math.max(1000, result.pollAfter || 5000));
      } catch {
        if (!stopped) { googleFeedback = 'Connexion interrompue. Nouvelle tentative…'; timer = setTimeout(poll, 10000); }
      }
    }
    timer = setTimeout(poll, 0);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  });

  function todayLocal(): string {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }

  function frenchDate(iso: string): string {
    return new Intl.DateTimeFormat('fr-FR', {day:'numeric', month:'short', year:'numeric', timeZone:'UTC'})
      .format(new Date(`${iso}T12:00:00Z`));
  }

  function confirmDelete(event: SubmitEvent, kind: string): void {
    if (!window.confirm(`Supprimer ${kind} définitivement ? Cette action est irréversible.`)) event.preventDefault();
  }
</script>

<svelte:head>
  <title>Atelier — SereTiny</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<div class="admin-page">
  <header class="admin-header">
    <a href="/" class="brand"><span class="house">⌂</span> Sere<span>Tiny</span><b>.</b></a>
    <div class="header-title"><span class="status-dot"></span>L'ATELIER PRIVÉ <span class="hide-mobile">/ ÉDITION DU JOURNAL</span></div>
    <div class="header-actions"><a href="/" target="_blank" rel="noopener">Voir le site ↗</a><form method="POST" action="?/logout"><button type="submit">Déconnexion</button></form></div>
  </header>

  <div class="admin-layout">
    <aside class="sidebar">
      <div class="sidebar-top"><span class="eyebrow">LE PROJET</span><h1>Table de travail.</h1><p>Un jour, une photo, une histoire.</p></div>
      <nav class="workshop-menu" aria-label="Menu de l’atelier">
        {#each menu as item}
          {@const active = data.view === item.id || (data.view === 'day' && item.id === 'days')}
          <a href="/admin?view={item.id}" class:active aria-current={active ? 'page' : undefined}><span class="menu-icon" aria-hidden="true">{item.icon}</span><span><strong>{item.title}</strong><small>{item.hint}</small></span>{#if item.id === 'comments' && data.comments.length}<b class="menu-count">{data.comments.length}</b>{/if}</a>
        {/each}
      </nav>
      <div class="statistics"><div><strong>{data.days.length}</strong><span>journées</span></div><div><strong>{photoCount}</strong><span>photos</span></div><div><strong>{publishedCount}</strong><span>affichées</span></div></div>
      <p class="sidebar-note">Le carnet du chantier, à ton rythme.</p>
    </aside>
    <main class="workspace" id="workspace">
      {#if data.notice}<p class="notice success" role="status">✓ {data.notice}</p>{/if}
      {#if data.warning}<p class="notice error" role="alert">{data.warning}</p>{/if}
      {#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}
      {#if data.view === 'days' || data.view === 'photos'}
        <div class="workspace-heading"><div><span class="eyebrow">LE JOURNAL / {data.view === 'days' ? 'RÉCITS' : 'IMAGES'}</span><h2>{data.view === 'days' ? 'Les journées' : 'La photothèque'}</h2><p>{data.view === 'days' ? 'Ouvre une journée pour raconter son histoire, ou gère la publication en lot.' : 'Retrouve tes images et modifie plusieurs dates ou légendes à la fois.'}</p></div><a class="secondary" href="/admin?view=imports">＋ Importer des photos</a></div>
        {#if data.view === 'days'}
          <details class="create-day paper"><summary>＋ Créer une journée</summary><form method="POST" action="?/createDay&view=days" class="create-day-form"><label>Date<input name="date" type="date" value={todayLocal()} required /></label><label>Titre français<input name="title_fr" maxlength="150" placeholder="Les premières découpes…" required /></label><button class="primary" type="submit">Créer la journée ↗</button></form><small>Le chapitre est déterminé automatiquement par la date.</small></details>
        {/if}
        <div class="filters paper">
          <label class="search-field">Rechercher<input type="search" bind:value={search} placeholder={data.view === 'days' ? 'Titre, récit ou date…' : 'Fichier, légende ou journée…'} /></label>
          <label>Chapitre<select bind:value={chapterFilter}><option value="all">Tous les chapitres</option><option value="none">Sans chapitre</option>{#each data.chapters as chapter}<option value={String(chapter.id)}>{chapter.title_fr}</option>{/each}</select></label>
          <label>Affichage<select bind:value={statusFilter}><option value="all">Toutes les journées</option><option value="published">Affichage activé</option><option value="hidden">Masquées</option></select></label>
          <label>Du<input type="date" bind:value={fromDate} /></label><label>Au<input type="date" bind:value={toDate} /></label>
          <button class="text-button" type="button" onclick={() => {search = ''; chapterFilter = 'all'; statusFilter = 'all'; fromDate = ''; toDate = '';}}>Réinitialiser</button>
        </div>
        <div class="results-heading"><span role="status">{total} {data.view === 'days' ? 'journée(s)' : 'photo(s)'} · {selectedIds.length} sélectionné(s)</span>{#if data.view === 'photos'}<div class="view-switch" role="group" aria-label="Présentation des photos"><button type="button" class:active={photoLayout === 'grid'} aria-pressed={photoLayout === 'grid'} onclick={() => photoLayout = 'grid'}>Grille</button><button type="button" class:active={photoLayout === 'list'} aria-pressed={photoLayout === 'list'} onclick={() => photoLayout = 'list'}>Liste</button></div>{/if}</div>
        {#if data.view === 'photos'}<p class="library-help">Photos classées par date de prise de vue, de la plus ancienne à la plus récente. Clique sur une légende ou une date pour la modifier, ou sur l’image pour l’agrandir.</p>{/if}
        <div class="bulk-bar">
          <label class="selection-label"><input type="checkbox" checked={allVisibleSelected} indeterminate={!allVisibleSelected && visibleIds.some(id => selectedIds.includes(id))} disabled={!visibleIds.length} onchange={(event) => selectVisible(event.currentTarget.checked)} /> Sélectionner cette page</label>
          {#if selectedIds.length}<button class="text-button" type="button" onclick={() => { selectedDays = []; selectedPhotos = []; }}>Désélectionner tout</button>{/if}
          {#if data.view === 'days'}<form method="POST" action="?/bulkDays&view=days" class="inline-actions">{#each selectedDays as id}<input name="ids" type="hidden" value={id} />{/each}<button class="secondary" name="decision" value="publish" disabled={!selectedDays.length}>Activer l’affichage</button><button class="outline-button" name="decision" value="hide" disabled={!selectedDays.length}>Masquer</button></form>{/if}
        </div>
        {#if data.view === 'days'}
          <div class="day-table" role="region" aria-label="Liste des journées"><table><thead><tr><th><span class="sr-only">Sélection</span></th><th>Journée</th><th>Chapitre</th><th>Photos</th><th>Affichage</th><th><span class="sr-only">Édition</span></th></tr></thead><tbody>{#each visibleDays as day (day.id)}<tr><td><input type="checkbox" value={String(day.id)} bind:group={selectedDays} aria-label="Sélectionner {day.title_fr}, {frenchDate(day.date)}" /></td><td><a class="day-title" href="/admin?day={day.id}">{#if day.photos[0]}<img src="/media/{day.photos[0].id}/thumb" alt="" loading="lazy" />{/if}<span><strong>{day.title_fr || 'Journée sans titre'}</strong><small>{frenchDate(day.date)}</small></span></a></td><td>{day.chapter_fr || 'Sans chapitre'}</td><td>{day.photos.length}</td><td><span class="row-status" class:live={!!day.published && !!day.photos.length}>{day.published ? day.photos.length ? 'En ligne' : 'Sans photos' : 'Masquée'}</span></td><td><a class="edit-link" href="/admin?day={day.id}" aria-label="Modifier {day.title_fr}">Modifier ↗</a></td></tr>{/each}</tbody></table></div>
        {:else}
          <details class="paper batch-editor" open={selectedPhotos.length > 0}><summary>Modifier les photos sélectionnées ({selectedPhotos.length})</summary><p>Seuls les champs cochés seront appliqués à toute la sélection. Une légende vide cochée efface la légende existante.</p><form method="POST" action="?/bulkPhotos&view=photos" onsubmit={(event) => { if (!window.confirm(`Appliquer ces modifications aux ${selectedPhotos.length} photos sélectionnées ?`)) event.preventDefault(); }}>
            {#each selectedPhotos as id}<input name="ids" type="hidden" value={id} />{/each}
            <div class="fields two"><div><label class="selection-label"><input name="change_date" type="checkbox" bind:checked={changeDate} /> Modifier la date d’affichage</label><label><span class="sr-only">Nouvelle date d’affichage</span><input name="date" type="date" disabled={!changeDate} required={changeDate} /></label><p>Une nouvelle date crée une journée avec affichage activé. Les photos déplacées vers une journée publiée deviennent visibles ; les anciennes journées et leurs récits sont conservés.</p></div><div><label class="selection-label"><input name="change_caption_fr" type="checkbox" bind:checked={changeCaptionFr} /> Remplacer la légende française</label><label><span class="sr-only">Légende française commune</span><textarea name="caption_fr" rows="2" maxlength="500" disabled={!changeCaptionFr}></textarea></label><label class="selection-label"><input name="change_caption_en" type="checkbox" bind:checked={changeCaptionEn} /> Remplacer la légende anglaise</label><label><span class="sr-only">Légende anglaise commune</span><textarea name="caption_en" rows="2" maxlength="500" disabled={!changeCaptionEn}></textarea></label></div></div><button class="primary" disabled={!selectedPhotos.length || (!changeDate && !changeCaptionFr && !changeCaptionEn)}>Appliquer à {selectedPhotos.length} photo(s) ↗</button>
          </form></details>
          <div class="library" class:list={photoLayout === 'list'}>
            {#each visiblePhotos as photo (photo.id)}
              <LibraryPhoto {photo} date={photo.day.date} dayId={photo.day.id} selected={selectedPhotos.includes(photo.id)} list={photoLayout === 'list'}
                onselect={(checked) => selectedPhotos = checked ? [...selectedPhotos, photo.id] : selectedPhotos.filter(id => id !== photo.id)}
                onpreview={() => openPreview(photo.id, photo.caption_fr)} />
            {/each}
          </div>
        {/if}
        {#if !total}<div class="empty-state"><h3>{data.days.length ? 'Aucun résultat' : 'Le chantier commence ici.'}</h3><p>{data.days.length ? 'Essaie d’autres critères ou réinitialise les filtres.' : 'Importe tes photos ou crée ta première journée.'}</p><a class="secondary" href="/admin?view=imports">Importer des photos ↗</a></div>{/if}
        {#if pageCount > 1}<nav class="pagination" aria-label="Pages de résultats"><button class="outline-button" disabled={currentPage === 1} onclick={() => page = currentPage - 1}>← Précédent</button><span role="status">Page {currentPage} / {pageCount}</span><button class="outline-button" disabled={currentPage === pageCount} onclick={() => page = currentPage + 1}>Suivant →</button></nav>{/if}
      {/if}
      {#if data.view === 'imports'}
        <div class="workspace-heading"><div><span class="eyebrow">AGRANDIR LE JOURNAL</span><h2>Importer des photos</h2><p>Choisis tes images, puis retrouve-les dans les journées et la photothèque.</p></div></div>
      <section class="paper" aria-labelledby="google-import-title">
        <div class="paper-heading"><span class="number" aria-hidden="true">G</span><div><h3 id="google-import-title">Depuis Google Photos</h3><p>Sélectionne tes photos, jusqu'à 2 000 éléments par sélection Google. Les journées sont créées par date de prise de vue et les photos déjà importées sont ignorées.</p></div></div>
        {#if shownGoogleProgress}
          {@const progress = shownGoogleProgress}
          <div class="google-progress" aria-busy={progress.status === 'running'}>
            <p role="status">{progress.status === 'running' ? (progress.total ? `Import en cours : ${progress.processed} / ${progress.total} éléments traités.` : 'Lecture de la sélection Google Photos…') : progress.status === 'failed' ? 'Import interrompu.' : 'Import terminé.'}</p>
            <progress max={progress.total || 1} value={progress.processed} aria-label="Progression de l’import Google Photos"></progress>
            <p>{progress.imported} photo(s) importée(s), {progress.created} journée(s) créée(s) avec affichage activé, {progress.duplicates} doublon(s) ignoré(s), {progress.failed} erreur(s).</p>
            {#if progress.selectedId && progress.status !== 'running'}<a href="/admin?day={progress.selectedId}">Voir les journées importées ↗</a>{/if}
            {#if progress.message}<p class="notice error" role="alert">{progress.message}</p>{/if}
            {#if progress.errors.length}
              <details><summary>Voir les erreurs ({progress.failed})</summary><ul>{#each progress.errors as error}<li>{error}</li>{/each}</ul>{#if progress.failed > progress.errors.length}<p>Les 20 premières erreurs sont affichées.</p>{/if}</details>
              <p>Tu peux réessayer la même sélection : les photos déjà importées seront ignorées.</p>
            {/if}
          </div>
        {/if}
        {#if !data.googlePhotos.configured}
          <p class="nothing-photo">Pour activer cet import, configure le client OAuth Google Photos sur le serveur. Les étapes sont décrites dans le README du projet.</p>
        {:else if !data.googlePhotos.pickerUri}
          {#if data.googlePhotos.connected}<p class="nothing-photo">Compte Google connecté. Tu peux choisir d’autres photos directement.</p>{/if}
          <form method="POST" action="?/connectGooglePhotos&view=imports"><button class="primary" type="submit">Choisir dans Google Photos <span aria-hidden="true">↗</span></button></form>
          {#if data.googlePhotos.connected}<div class="save-bar"><form method="POST" action="?/switchGooglePhotos&view=imports"><button class="secondary" type="submit">Changer de compte Google</button></form><form method="POST" action="?/disconnectGooglePhotos&view=imports"><button class="secondary" type="submit">Déconnecter Google Photos</button></form></div>{/if}
        {:else}
          <div class="upload-box"><div><strong>1. Sélectionner les photos dans Google</strong><p>Valide ta sélection dans Google Photos, puis reviens ici. Les vidéos ne sont pas importées.</p></div><a class="secondary" href={data.googlePhotos.pickerUri} target="_blank" rel="noopener noreferrer">Ouvrir Google Photos ↗</a></div>
          <p class="nothing-photo" role="status">{googleFeedback || (googleReady ? 'Sélection prête à importer.' : 'En attente de ta sélection dans Google Photos…')}</p>
          <form method="POST" action="?/importGooglePhotos&view=imports">
            <div class="fields two">
              <label>Date de remplacement <small>(si aucune date n'est disponible)</small><input name="fallback_date" type="date" /></label>
            </div>
            <p class="nothing-photo">Les journées existantes sont réutilisées. Les photos ajoutées à une journée publiée seront visibles sur le site.</p>
            <button class="primary" type="submit" disabled={googleBusy}>{googleBusy ? 'Import en cours…' : '2. Importer la sélection'} <span aria-hidden="true">↗</span></button>
          </form>
          <div class="save-bar"><form method="POST" action="?/connectGooglePhotos&view=imports"><button class="secondary" type="submit" disabled={googleBusy}>Nouvelle sélection</button></form><form method="POST" action="?/switchGooglePhotos&view=imports"><button class="secondary" type="submit" disabled={googleBusy}>Changer de compte Google</button></form><form method="POST" action="?/disconnectGooglePhotos&view=imports"><button class="secondary" type="submit" disabled={googleBusy}>Déconnecter Google Photos</button></form></div>
        {/if}
      </section>
      <section class="paper" aria-labelledby="auto-import-title">
        <div class="paper-heading"><span class="number" aria-hidden="true">＋</span><div><h3 id="auto-import-title">Des photos aux journées</h3><p>Les photos sont regroupées par date de prise de vue (EXIF). Les nouvelles journées sont visibles sur le site dès l’import des photos. Les fichiers déjà importés sont ignorés.</p></div></div>
        <form method="POST" action="?/importPhotos&view=imports" enctype="multipart/form-data">
          <div class="upload-box">
            <div><strong>Importer plusieurs journées à la fois</strong><p id="auto-import-help">1 à 8 photos, JPG, PNG, WebP ou AVIF, 12 Mo par image. Les journées existantes sont réutilisées ; si elles sont publiées, les nouvelles photos seront visibles.</p></div>
            <input name="photos" aria-label="Photos à regrouper par date de prise de vue" aria-describedby="auto-import-help" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple required />
          </div>
          <div class="fields two">
            <label>Date de remplacement <small>(si la photo n'a pas de date EXIF)</small><input name="fallback_date" type="date" aria-describedby="fallback-help" /><small id="fallback-help">Facultative. Sans cette date, les photos sans date de prise de vue ne sont pas importées et sont signalées.</small></label>
          </div>
          <button class="primary" type="submit">Importer et créer les journées <span aria-hidden="true">↗</span></button>
        </form>
      </section>
      {/if}
      {#if data.view === 'day'}
      {#if selected}
      {#key selected.id}
        <a class="back-link" href="/admin?view=days">← Toutes les journées</a>
        <div class="workspace-heading"><div><span class="eyebrow">ÉDITION / {frenchDate(selected.date).toUpperCase()}</span><h2>{selected.title_fr || 'Une journée à raconter'}</h2><p>Rédige ton récit et ajoute des photos. L’affichage sur le site est activé par défaut.</p></div><span class:published={selected.published} class="publication-chip">{selected.published ? (selected.photos.length ? '● EN LIGNE' : '○ EN ATTENTE DE PHOTOS') : '○ MASQUÉE'}</span></div>
        <form method="POST" action="?/saveDay&view=day&day={selected.id}" class="paper main-form">
          <input type="hidden" name="id" value={selected.id} />
          <div class="paper-heading"><span class="number">01</span><div><h3>Le récit de cette journée</h3><p>Tu peux revenir modifier ce texte à tout moment.</p></div></div>
          <div class="fields two"><label>Date de la journée <input name="date" type="date" value={selected.date} required /></label><div><span>Chapitre : {selected.chapter_fr || 'Sans chapitre'}</span><p class="nothing-photo">Déterminé automatiquement par la date enregistrée. <a href="/admin?view=chapters">Modifier les dates des chapitres ↗</a></p></div></div>
          <div class="fields two"><label>Titre en français<input name="title_fr" value={selected.title_fr} maxlength="150" placeholder="Une journée dans l'atelier" required /></label><label>Title in English <small>(optionnel)</small><input name="title_en" value={selected.title_en} maxlength="150" placeholder="A day in the workshop" /></label></div>
          <div class="fields two body-fields"><label>Le texte du jour<textarea name="body_fr" rows="7" maxlength="8000" placeholder="Aujourd'hui, nous avons enfin…">{selected.body_fr}</textarea></label><label>English version <small>(optionnel)</small><textarea name="body_en" rows="7" maxlength="8000" placeholder="Today we finally…">{selected.body_en}</textarea></label></div>
          <div class="save-bar"><label class="publish-toggle"><input type="checkbox" name="published" checked={!!selected.published} /><span>Afficher cette journée sur le site</span></label><button class="primary" type="submit">Enregistrer la journée <span>↗</span></button></div>
        </form>

        <section class="paper photo-section">
        <div class="paper-heading"><span class="number">02</span><div><h3>Les photos</h3><p>Ajoute jusqu'à 8 photos à la fois. Formats JPG, PNG, WebP et AVIF (12 Mo par image). Les photos sont classées automatiquement par date de prise de vue.</p></div></div>
          <form method="POST" action="?/upload&view=day&day={selected.id}" enctype="multipart/form-data" class="upload-box">
            <input type="hidden" name="day_id" value={selected.id} />
            <span class="upload-symbol">＋</span>
            <div><strong>Importer depuis l'ordinateur ou le téléphone</strong><p>Choisis tes images, puis écris leurs légendes ci-dessous.</p></div>
            <input name="photos" aria-label="Sélectionner les photos" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple required />
            <button class="secondary" type="submit">Importer les photos</button>
          </form>
          {#if selected.photos.length}
            <div class="photo-list">
              {#each selected.photos as photo,i (photo.id)}
                <article class="photo-card" id="photo-{photo.id}">
                  <img class="photo-preview" src="/media/{photo.id}/thumb" alt={photo.caption_fr || `Image ${i+1}`} loading="lazy" />
                  <div class="photo-fields">
                    <div class="photo-title"><strong>PHOTO {String(i+1).padStart(2, '0')}</strong><small>{photo.original_name}</small></div>
                    <form method="POST" action="?/savePhoto&view=day&day={selected.id}">
                      <input type="hidden" name="id" value={photo.id} /><input type="hidden" name="return_to" value={selected.id} />
                      <label>Date d'affichage <input name="date" type="date" value={selected.date} required /></label>
                      <label class="wide">Légende française<textarea name="caption_fr" rows="2" maxlength="500" placeholder="Une courte histoire derrière la photo…">{photo.caption_fr}</textarea></label>
                      <label class="wide">Caption in English <small>(facultatif)</small><textarea name="caption_en" rows="2" maxlength="500" placeholder="A little story behind this photo…">{photo.caption_en}</textarea></label>
                      <button class="secondary save-photo" type="submit">Enregistrer cette photo ↗</button>
                    </form>
                    <form method="POST" action="?/deletePhoto&view=day&day={selected.id}" class="delete-photo" onsubmit={(event) => confirmDelete(event,'cette photo')}>
                      <input type="hidden" name="id" value={photo.id} /><input type="hidden" name="day_id" value={selected.id} /><button type="submit">Supprimer la photo</button>
                    </form>
                  </div>
                </article>
              {/each}
            </div>
          {:else}<p class="nothing-photo">Cette journée n'a pas encore de photos. Tu pourras la publier après en avoir ajouté au moins une.</p>{/if}
        </section>

        <form method="POST" action="?/deleteDay&view=day&day={selected.id}" class="danger-zone" onsubmit={(event) => confirmDelete(event,'cette journée, ses photos et ses commentaires')}>
          <input name="id" type="hidden" value={selected.id} /><span>Plus besoin de cette journée ?</span><button type="submit">Supprimer définitivement</button>
        </form>
      {/key}
      {:else}
        <div class="welcome"><h2>Journée introuvable.</h2><p>Choisis une journée dans la liste pour ouvrir sa fiche.</p><a class="secondary" href="/admin?view=days">Voir les journées</a></div>
      {/if}

      {/if}
      {#if data.view === 'chapters'}
      <section class="additional" id="chapitres">
        <div class="section-heading"><div><span class="eyebrow">ORGANISATION</span><h2>Les chapitres</h2><p>Chaque chapitre commence à sa date de début et se termine au début du suivant. Les journées et les photos y sont rattachées automatiquement selon leur date. Le dernier chapitre reste ouvert.</p></div></div>
        <div class="chapter-grid">
          {#each data.chapters as chapter,i (chapter.id)}
            <form method="POST" action="?/saveChapter&view=chapters" class="chapter-card">
              <input name="id" type="hidden" value={chapter.id} />
              <span class="chapter-index">CHAPITRE {String(i+1).padStart(2,'0')}</span>
              <label>Nom français<input name="title_fr" maxlength="100" value={chapter.title_fr} required /></label>
              <label>English name<input name="title_en" maxlength="100" value={chapter.title_en} /></label>
              <label>Date de début<input name="start_date" type="date" value={chapter.start_date ?? ''} required /></label>
              <small>{!chapter.start_date ? 'À dater pour apparaître sur la frise.' : chapter.end_date ? `Jusqu’au ${frenchDate(chapter.end_date)} (exclu).` : 'En cours · sans date de fin.'}</small>
              <button type="submit">Sauvegarder ↗</button>
            </form>
          {/each}
          <form method="POST" action="?/addChapter&view=chapters" class="chapter-card new-chapter"><span class="chapter-index">NOUVEAU CHAPITRE ＋</span><label>Nom français<input name="title_fr" maxlength="100" placeholder="Le toit" required /></label><label>English name<input name="title_en" maxlength="100" placeholder="The roof" /></label><label>Date de début<input name="start_date" type="date" required /></label><button type="submit">Ajouter ↗</button></form>
        </div>
      </section>

      {/if}
      {#if data.view === 'comments'}
      <section class="additional" id="commentaires">
        <div class="section-heading"><div><span class="eyebrow">COMMUNAUTÉ</span><h2>Les commentaires</h2><p>Les messages sont invisibles tant que tu ne les as pas approuvés.</p></div><span class="publication-chip">{data.comments.length} EN ATTENTE</span></div>
        {#if data.comments.length}
          <form method="POST" action="?/bulkComments&view=comments" class="bulk-bar" onsubmit={(event) => { if ((event.submitter as HTMLButtonElement)?.value === 'delete') confirmDelete(event, 'les commentaires sélectionnés'); }}>
            <label class="selection-label"><input type="checkbox" checked={data.comments.length > 0 && selectedComments.length === data.comments.length} indeterminate={selectedComments.length > 0 && selectedComments.length < data.comments.length} onchange={(event) => selectedComments = event.currentTarget.checked ? data.comments.map(comment => String(comment.id)) : []} /> Tout sélectionner</label>
            <span role="status">{selectedComments.length} sélectionné(s)</span>
            <button class="secondary" name="decision" value="approve" disabled={!selectedComments.length}>Approuver</button>
            <button class="reject" name="decision" value="delete" disabled={!selectedComments.length}>Supprimer</button>
            {#each selectedComments as id}<input type="hidden" name="ids" value={id} />{/each}
          </form>
          {#each data.comments as comment (comment.id)}
            <article class="comment-card"><label class="selection-label"><input type="checkbox" value={String(comment.id)} bind:group={selectedComments} aria-label="Sélectionner le commentaire de {comment.author}" /></label><div class="comment-content"><div class="comment-by"><strong>{comment.author}</strong> · {new Date(comment.created_at).toLocaleString('fr-FR')} · <a href="/admin?day={comment.day_id}">{data.days.find(day => day.id === comment.day_id)?.title_fr || `Journée #${comment.day_id}`}</a></div><p>{comment.body}</p></div><div class="comment-actions"><form method="POST" action="?/moderate&view=comments"><input type="hidden" name="id" value={comment.id} /><input type="hidden" name="decision" value="approve" /><button class="secondary" type="submit">✓ Approuver</button></form><form method="POST" action="?/moderate&view=comments" onsubmit={(event) => confirmDelete(event, "ce commentaire")}><input type="hidden" name="id" value={comment.id} /><input type="hidden" name="decision" value="delete" /><button class="reject" type="submit">Supprimer</button></form></div></article>
          {/each}
        {:else}<p class="no-pending">Aucun commentaire en attente. Tout est à jour !</p>{/if}
      </section>
      {/if}
      <footer class="admin-footer">SereTiny · Un projet qui se construit jour après jour. <a href="/">Retour au site ↗</a></footer>
    </main>
  </div>
</div>

<dialog class="photo-lightbox" bind:this={previewDialog} onclose={() => preview = null} aria-label="Photo en grand">
  <button class="close-preview" type="button" onclick={() => previewDialog.close()} aria-label="Fermer l’aperçu">×</button>
  {#if preview}<img src="/media/{preview.id}/large" alt={preview.caption || 'Photo du chantier en grand'} />{#if preview.caption}<p>{preview.caption}</p>{/if}{/if}
</dialog>

<style>
  .library-help{font-size:11px;color:#876e56;line-height:1.6;margin:0 0 15px}.photo-lightbox{position:fixed;inset:0;width:min(1200px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:20px;border:1px solid #76614f;background:#211b17;color:#f4e8d7;overflow-y:auto;box-shadow:0 24px 100px #0008}.photo-lightbox::backdrop{background:#160f0be8;backdrop-filter:blur(6px)}.photo-lightbox img{display:block;max-width:100%;width:100%;height:min(78dvh,950px);object-fit:contain}.photo-lightbox p{margin:15px 45px 0 0;font-size:14px;line-height:1.6;white-space:pre-wrap}.close-preview{position:sticky;float:right;top:0;width:38px;height:38px;border:1px solid #b39575;background:#34281f;color:#f4e8d7;font-size:26px;z-index:1}.workspace .additional{margin-top:0}
  @media(max-width:700px){.sidebar .statistics{display:none}.photo-lightbox{padding:12px}.photo-lightbox img{height:72dvh}}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .workshop-menu{display:grid;gap:7px;margin:25px 0 35px}.workshop-menu a{display:flex;align-items:center;gap:13px;padding:14px 12px;border:1px solid transparent;border-radius:3px}.workshop-menu a:hover{background:#ece2d5}.workshop-menu a.active{background:#423125;color:#fff4e6;border-color:#423125;box-shadow:0 4px 10px #30201213}.workshop-menu strong{display:block;font-size:13px}.workshop-menu small{display:block;font-size:10px;opacity:.7;margin-top:3px}.menu-icon{font-size:23px;width:25px;text-align:center}.menu-count{font-size:11px;background:#b28558;color:white;border-radius:20px;padding:2px 7px;margin-left:auto}.sidebar-note{font-size:11px;color:#8a7763}.sidebar{position:sticky;top:78px;align-self:start;height:calc(100dvh - 78px);overflow-y:auto}
  select{display:block;width:100%;min-width:0;margin-top:7px;border:1px solid #d6caba;background:#fffdf9;color:#382f25;padding:12px 9px;font-size:12px;border-radius:2px}.filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px;padding:20px}.search-field{grid-column:span 2}.text-button{border:0;background:transparent;color:#775638;font-size:12px;text-decoration:underline;padding:10px 0;text-align:left}.create-day{padding:18px 22px}.create-day summary,.batch-editor summary{cursor:pointer;font-size:14px;font-weight:700;color:#654b34}.create-day-form{display:grid;grid-template-columns:minmax(140px,1fr) minmax(180px,2fr) auto;gap:16px;align-items:end;padding:20px 0 14px}.create-day small{font-size:11px;color:#887767}.results-heading,.bulk-bar,.inline-actions,.pagination{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.results-heading{justify-content:space-between;margin:25px 0 15px;font-size:12px;color:#7c6855}.bulk-bar{padding:16px 18px;background:#e1d5c5;border:1px solid #d0bfa9;margin-bottom:18px;font-size:12px}.selection-label{display:flex;align-items:center;gap:10px;font-size:12px;cursor:pointer}.inline-actions{margin-left:auto;gap:8px}.outline-button{border:1px solid #bba38b;background:#f7f0e6;color:#694b32;padding:10px 14px;font-size:11px;font-weight:700}.view-switch{display:flex;border:1px solid #c8b9a6}.view-switch button{border:0;background:transparent;color:#725a44;padding:8px 15px;font-size:12px}.view-switch button.active{background:#6c513b;color:#fff7e9}input[type='checkbox']{width:18px;height:18px;accent-color:#70553e;flex-shrink:0;cursor:pointer}button:disabled{cursor:not-allowed}
  .day-table{overflow-x:auto;border:1px solid #d7cbbc;background:#faf6ef}.day-table table{width:100%;border-collapse:collapse;text-align:left;min-width:650px}.day-table th{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#8b725b;font-weight:600;background:#eee4d6;padding:14px}.day-table td{padding:16px 14px;border-top:1px solid #e5d9ca;font-size:12px}.day-table tr:hover td{background:#f2e9dc}.day-title{display:flex;align-items:center;gap:13px;min-width:170px}.day-title img{width:46px;height:46px;object-fit:cover;flex:none}.day-title strong{display:block;font-weight:600;max-width:290px;overflow-wrap:anywhere}.day-title small{display:block;margin-top:4px;font-size:11px;color:#88725d}.edit-link{white-space:nowrap;color:#88603e;text-decoration:underline}.row-status{font-size:10px;background:#e9e0d4;color:#73634f;padding:5px 8px;white-space:nowrap}.row-status.live{background:#e2e9da;color:#49643d}
  .batch-editor p{font-size:12px;color:#887361;line-height:1.6}.batch-editor form{margin-top:22px}.batch-editor .selection-label{margin-top:14px}.library{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.library.list{grid-template-columns:1fr}.pagination{justify-content:center;margin-top:25px;font-size:12px}.empty-state{text-align:center;padding:50px 25px;background:#f5eee3;border:1px dashed #cbb79e}.empty-state h3{font:400 28px 'Fraunces',serif;margin:0 0 12px}.empty-state p{font-size:13px;color:#8a745c;margin-bottom:25px}.back-link{display:inline-block;font-size:12px;color:#88603e;margin-bottom:22px}.additional{margin-top:0}.comment-content{flex:1;min-width:0}.comment-by a{text-decoration:underline}.photo-card{scroll-margin-top:100px}.admin-page a.secondary{display:inline-block}.workspace-heading>a.secondary{margin-top:10px}
  @media(min-width:1500px){.library{grid-template-columns:repeat(4,minmax(0,1fr))}}
  @media(max-width:1100px){.library{grid-template-columns:repeat(2,minmax(0,1fr))}.filters{grid-template-columns:repeat(2,minmax(0,1fr))}.create-day-form{grid-template-columns:1fr}.inline-actions{margin-left:0}}
  @media(max-width:700px){.sidebar{position:static;height:auto;overflow:visible}.sidebar-top,.sidebar-note,.statistics{display:none}.workshop-menu{display:flex;overflow-x:auto;margin:0;gap:7px;padding:0 0 5px}.workshop-menu a{flex-shrink:0;padding:10px;gap:7px}.workshop-menu small{display:none}.workshop-menu strong{font-size:12px}.menu-icon{font-size:19px;width:20px}.workspace-heading{flex-wrap:wrap}.workspace-heading>a.secondary{margin:0}.filters{padding:16px;gap:12px}.bulk-bar{padding:12px;gap:12px}.library{gap:10px}.comment-card>.selection-label{float:left;margin:0 12px 8px 0}.admin-footer{flex-direction:column}.photo-card{scroll-margin-top:85px}}
  .google-progress{background:#eee8dd;border:1px solid #d7cbbc;padding:16px;margin-bottom:20px;font-size:12px;overflow-wrap:anywhere}.google-progress progress{width:100%;height:12px;accent-color:#85603f}.google-progress a{text-decoration:underline}.google-progress summary{cursor:pointer}.google-progress li{margin-top:8px}button:disabled{opacity:.6;cursor:wait}
  .admin-page{background:#eae3d8;color:#3d3025;min-height:100dvh;line-height:1.45}
  .admin-header{height:78px;background:#29211b;display:flex;align-items:center;gap:48px;padding:0 clamp(22px,4vw,65px);color:#eee0cf;position:sticky;top:0;z-index:8;box-shadow:0 9px 20px #26190e19}
  .brand{font-family:'Fraunces',Georgia,serif;font-size:25px;letter-spacing:-.065em;white-space:nowrap}.brand span:not(.house){color:#d6b487}.brand b{color:#d99f5f}.house{color:#c9a075;font-size:35px;font-weight:400;vertical-align:-2px;margin-right:8px}
  .header-title{font-size:10px;letter-spacing:.16em;font-weight:700;color:#b7a28e;display:flex;align-items:center;gap:10px}.status-dot{width:7px;height:7px;background:#b99767;border-radius:50%}
  .header-actions{display:flex;align-items:center;gap:23px;margin-left:auto}.header-actions a{font-size:12px;color:#ddc1a1}.header-actions button{font-size:12px;color:#baaa9a;border:1px solid #82705e;padding:9px 13px;background:none}
  .admin-layout{display:grid;grid-template-columns:minmax(275px,330px) minmax(0,1fr);max-width:1680px;margin:auto;min-height:calc(100dvh - 78px)}
  .sidebar{background:#f4eee5;border-right:1px solid #d2c6b6;padding:38px 23px;min-width:0}.sidebar-top{padding:0 8px}.eyebrow{font-size:10px;letter-spacing:.18em;font-weight:700;color:#a77b51}.sidebar-top h1{font:400 33px 'Fraunces',serif;letter-spacing:-.04em;margin:10px 0}.sidebar-top p{font-size:13px;color:#877362;margin:0 0 26px}
  .statistics{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;border-top:1px solid #ded3c5;border-bottom:1px solid #ded3c5;padding:17px 4px;margin-bottom:31px}.statistics div{display:flex;flex-direction:column;gap:2px}.statistics strong{font:400 26px 'Fraunces',serif}.statistics span{font-size:10px;letter-spacing:.07em;color:#8d7b68}
  
  
  label{display:block;font-size:12px;font-weight:700;color:#6c5440}label small{font-size:10px;color:#9f8a74;font-weight:500}
  input:not([type='checkbox']):not([type='file']), textarea{display:block;width:100%;background:#fffdf9;border:1px solid #d6caba;color:#382f25;padding:12px 13px;font-size:13px;line-height:1.4;margin-top:7px;border-radius:2px;min-width:0}
  textarea{resize:vertical;white-space:pre-wrap}
  
  button.primary{background:#423125;color:#f7ecdc;border:0;display:flex;justify-content:space-between;align-items:center;gap:20px;padding:13px 18px;font-size:12px;font-weight:700;letter-spacing:.02em}.primary:hover{background:#715035}
  .workspace{padding:clamp(25px,3.6vw,56px);min-width:0}.notice{padding:12px 18px;margin:0 0 22px;font-size:13px;border-left:3px solid}.success{background:#e2e8da;color:#42603b;border-color:#668954}.error{background:#f7ded9;color:#923a2d;border-color:#b95b49}
  .workspace-heading,.section-heading{display:flex;justify-content:space-between;gap:22px;align-items:start;margin-bottom:25px}.workspace-heading h2,.section-heading h2,.welcome h2{font:400 clamp(34px,4vw,52px) 'Fraunces',serif;letter-spacing:-.06em;line-height:1.12;margin:10px 0 8px}.workspace-heading p,.section-heading p,.welcome p{margin:0;color:#887767;font-size:13px;line-height:1.6}.publication-chip{white-space:nowrap;border:1px solid #cab9a4;color:#958675;background:#eee8df;font-size:9px;font-weight:700;letter-spacing:.14em;padding:11px 14px;margin-top:13px}.publication-chip.published{color:#577047;background:#e5eadf;border-color:#b7c2ad}
  .paper{background:#f9f5ee;border:1px solid #d7cbbc;padding:clamp(20px,2.2vw,34px);box-shadow:0 12px 40px #3b25100b;margin-bottom:19px}.paper-heading{display:flex;gap:17px;align-items:start;margin-bottom:24px}.number{color:#b58a61;font-family:'Fraunces',serif;font-size:24px}.paper-heading h3{font:400 26px 'Fraunces',serif;letter-spacing:-.03em;margin:0 0 4px}.paper-heading p{font-size:12px;color:#998775;margin:0}
  .fields{display:grid;gap:18px;margin-bottom:20px}.fields.two{grid-template-columns:repeat(2,minmax(0,1fr))}.body-fields textarea{min-height:163px}.save-bar{margin-top:18px;padding-top:19px;border-top:1px solid #e1d6c8;display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap}.publish-toggle{display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer}.publish-toggle input{width:18px;height:18px;accent-color:#70553e}
  .upload-box{display:flex;align-items:center;gap:18px;flex-wrap:wrap;border:1px dashed #c0a58c;background:#f0e8dd;padding:20px;margin-bottom:19px}.upload-symbol{font:300 44px 'Fraunces',serif;color:#aa8967}.upload-box div{flex:1;min-width:170px}.upload-box strong{font-size:13px}.upload-box p{font-size:11px;color:#907c69;margin:3px 0 0}.upload-box input{max-width:215px;font-size:11px;color:#6a5543}.upload-box input::file-selector-button{display:block;padding:8px;background:#dfd1c0;border:0;margin-bottom:7px;cursor:pointer}.secondary{background:#6c513b;color:#fffaee;border:0;padding:11px 14px;font-size:11px;font-weight:700;white-space:nowrap}.secondary:hover{background:#493628}
  .photo-list{display:grid;gap:16px}.photo-card{display:grid;grid-template-columns:185px minmax(0,1fr);border:1px solid #dfd4c6;background:#fffcf7}.photo-preview{width:185px;height:100%;min-height:275px;max-height:500px;object-fit:cover;background:#c9bba9}.photo-fields{padding:17px 18px}.photo-title{display:flex;align-items:center;gap:14px;margin-bottom:11px}.photo-title strong{font-size:11px;letter-spacing:.13em;color:#937455}.photo-title small{font-size:10px;color:#978674;overflow-wrap:anywhere}.photo-fields form:not(.delete-photo){display:grid;grid-template-columns:minmax(0,1fr) minmax(90px,160px);gap:10px}.photo-fields label.wide{grid-column:1/-1}.photo-fields textarea{min-height:48px}.save-photo{grid-column:1/-1;justify-self:start}.delete-photo{margin-top:12px}.delete-photo button,.danger-zone button{background:none;border:0;padding:0;text-decoration:underline;color:#a35e4b;font-size:11px}.nothing-photo{font-size:12px;color:#8a7866;padding:12px 0}.danger-zone{padding:12px 6px;display:flex;justify-content:space-between;gap:10px;color:#9d8a76;font-size:11px}
  .additional{margin-top:57px}.chapter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px}.chapter-card{padding:20px;border:1px solid #d6c6b6;background:#f8f2e9;display:grid;gap:13px}.chapter-index{font-size:10px;letter-spacing:.15em;font-weight:700;color:#9a7555}.chapter-card button{border:0;background:none;text-align:left;color:#755334;font-weight:700;font-size:12px;padding:5px 0}.new-chapter{background:#e2d6c6}
  .comment-card{background:#f8f2e9;border:1px solid #d6c6b6;padding:22px;display:flex;justify-content:space-between;gap:20px;align-items:center;margin:10px 0}.comment-by{font-size:11px;color:#907764}.comment-by strong{color:#483729}.comment-card p{margin:9px 0 0;font-size:13px;line-height:1.7;overflow-wrap:anywhere;white-space:pre-wrap}.comment-actions{display:flex;gap:8px;flex-shrink:0}.reject{background:none;border:1px solid #bb7b6d;color:#a35e4b;padding:10px 13px;font-size:11px}.no-pending{color:#938271;font-size:12px}.admin-footer{border-top:1px solid #d7cabb;margin-top:60px;padding-top:23px;font-size:11px;color:#9b8976;display:flex;gap:15px;justify-content:space-between}.admin-footer a{text-decoration:underline}
  .welcome{position:relative;min-height:330px;background:#f5eee3;border:1px solid #d7cbbc;padding:50px;overflow:hidden}.welcome h2{max-width:480px}.welcome p{max-width:390px}
  @media(max-width:950px){.admin-header{gap:17px}.hide-mobile{display:none}.admin-layout{grid-template-columns:240px minmax(0,1fr)}.sidebar{padding:27px 14px}.workspace{padding:25px}.photo-card{grid-template-columns:125px minmax(0,1fr)}.photo-preview{width:125px}.upload-box{align-items:start}.upload-box input{max-width:100%}}
  @media(max-width:700px){.admin-header{height:65px;padding:0 16px}.brand{font-size:21px}.house{font-size:27px}.header-title{display:none}.header-actions{gap:12px}.header-actions a{font-size:11px}.header-actions button{font-size:10px;padding:7px}.admin-layout{display:block}.sidebar{padding:26px 18px;border-right:0;border-bottom:1px solid #d5c9bb}.sidebar-top h1{font-size:30px}.statistics{max-width:380px}.workspace{padding:25px 16px}.workspace-heading h2{font-size:36px}.fields.two{grid-template-columns:1fr}.photo-card{grid-template-columns:1fr}.photo-preview{width:100%;height:190px;min-height:0}.comment-card{display:block}.comment-actions{margin-top:15px}.welcome{padding:32px}.publication-chip{font-size:8px}.upload-box{padding:16px}.photo-fields form:not(.delete-photo){grid-template-columns:1fr 1fr}.save-bar{align-items:start}}
</style>
