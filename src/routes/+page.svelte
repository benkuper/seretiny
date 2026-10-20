<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { Chapter, Day, Language } from '#lib/types.js';
  import MediaVideo from '#lib/components/MediaVideo.svelte';

  let { data }: { data: { days: Day[]; chapters: Chapter[] } } = $props();
  let language = $state<Language>('fr');
  let position = $state(0);
  let photoPosition = $state(0);
  let photoThumbs = $state<HTMLDivElement>();
  let commentsOpen = $state(false);
  let storyOpen = $state(false);
  let storyCopy = $state<HTMLParagraphElement>();
  let storyOverflows = $state(false);
  let lightboxOpen = $state(false);
  let autoplay = $state(true);
  let compactGallery = $state(false);
  let pageVisible = $state(false);
  let visitorName = $state('');
  let visitorMessage = $state('');
  let trap = $state('');
  let submitting = $state(false);
  let commentFeedback = $state('');
  let commentError = $state(false);
  let track = $state<HTMLDivElement>(null!);
  let experience: HTMLDivElement;
  let lastWheel = 0;
  let pointerStart = 0;
  let trackStart = 0;
  let moved = false;
  let dragging = $state(false);

  let currentDay = $derived(data.days[position] as Day | undefined);
  let currentPhoto = $derived(currentDay?.photos[photoPosition]);
  let chapterNumber = $derived(data.chapters.findIndex(chapter => chapter.id === currentDay?.chapter_id) + 1);

  const strings = {
    fr: {
      tagline: 'Le journal d’une petite maison', timeline: 'Les journées',
      comments: 'Laisser un mot',
      read: 'Lire la suite',
      empty: 'Le carnet de construction d’une petite maison.',
      emptyHelp: 'Les premières photos arrivent bientôt.',
      close: 'Fermer', discussions: 'Autour de cette journée',
      commentsIntro: 'Un petit mot, une question, une idée ? Participe à la conversation.',
      name: 'Ton prénom', message: 'Ton commentaire', send: 'Envoyer mon commentaire',
      moderation: 'Les commentaires apparaissent après validation.', noComments: 'Sois le premier à laisser un mot.',
      sent: 'Merci ! Ton commentaire sera visible après validation.',
      next: 'Journée suivante', previous: 'Journée précédente', story: 'Le récit du jour',
      chapter: 'chapitre', photoCaption: 'Légende', picture: 'Photo', video: 'Vidéo', phase: 'Sans chapitre',
      captionFallback: 'Un instant de la construction',
      expand: 'Agrandir le média', previousPhoto: 'Média précédent', nextPhoto: 'Média suivant',
      back: 'Retour à la photo', pause: 'Mettre le diaporama en pause', play: 'Reprendre le diaporama'
    },
    en: {
      tagline: 'A little house build journal', timeline: 'The days',
      comments: 'Leave a note',
      read: 'Read more',
      empty: 'The construction notebook of a little house.',
      emptyHelp: 'First photos coming soon.',
      close: 'Close', discussions: 'About this day',
      commentsIntro: 'A thought, a question or an idea? Join the conversation.',
      name: 'Your name', message: 'Your comment', send: 'Send comment',
      moderation: 'Comments appear after approval.', noComments: 'Be the first to leave a note.',
      sent: 'Thank you! Your comment will appear after review.',
      next: 'Next day', previous: 'Previous day', story: 'The day’s story',
      chapter: 'chapter', photoCaption: 'Caption', picture: 'Photo', video: 'Video', phase: 'Uncategorized',
      captionFallback: 'A moment from the construction',
      expand: 'Enlarge media', previousPhoto: 'Previous media', nextPhoto: 'Next media',
      back: 'Back to the photo', pause: 'Pause slideshow', play: 'Resume slideshow'
    }
  } as const;
  let t = $derived(strings[language]);

  function localized(fr: string | null | undefined, en: string | null | undefined) {
    return language === 'en' && en?.trim() ? en : (fr || '');
  }
  $effect(() => {
    const paragraph = storyCopy;
    const text = localized(currentDay?.body_fr, currentDay?.body_en);
    if (!paragraph || !text.trim()) { storyOverflows = false; return; }
    let frame = 0;
    let disposed = false;
    function scheduleMeasurement() {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Measure the room available without the link so it cannot cause its own overflow.
        const link = paragraph!.parentElement?.querySelector<HTMLButtonElement>('.read-link');
        if (link) link.hidden = true;
        storyOverflows = paragraph!.getClientRects().length === 0 ||
          paragraph!.scrollHeight > paragraph!.clientHeight + 1 ||
          paragraph!.scrollWidth > paragraph!.clientWidth + 1;
        if (link) link.hidden = false;
      });
    }
    const observer = new ResizeObserver(scheduleMeasurement);
    observer.observe(paragraph);
    if (paragraph.parentElement) observer.observe(paragraph.parentElement);
    window.addEventListener('resize', scheduleMeasurement);
    document.fonts.addEventListener('loadingdone', scheduleMeasurement);
    void document.fonts.ready.then(scheduleMeasurement);
    scheduleMeasurement();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', scheduleMeasurement);
      document.fonts.removeEventListener('loadingdone', scheduleMeasurement);
    };
  });
  function prettyDate(date: string, compact=false) {
    const d = new Date(`${date}T12:00:00Z`);
    return new Intl.DateTimeFormat(language === 'fr' ? 'fr-FR' : 'en-GB', {
      day: 'numeric', month: compact ? 'short' : 'long', year: compact ? undefined : 'numeric', timeZone: 'UTC'
    }).format(d);
  }
  function closestDayIndex(now = new Date()) {
    // Comparer les jours calendaires, indépendamment de l'heure et des changements d'heure.
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    let closest = 0;
    let distance = Infinity;
    data.days.forEach((day, i) => {
      const delta = Math.abs(Date.parse(`${day.date}T00:00:00Z`) - today);
      if (delta < distance) { closest = i; distance = delta; }
    });
    return closest;
  }
  function syncTrack(i: number) {
    if (!track) return;
    const target = track.querySelector<HTMLElement>(`[data-tick="${i}"]`);
    if (!target) return;
    track.scrollTo({left: target.offsetLeft + target.offsetWidth / 2 - track.clientWidth / 2, behavior:'smooth'});
  }
  function selectDay(i: number, updateHash = true) {
    if (!data.days.length) return;
    position = Math.max(0, Math.min(data.days.length-1,i));
    photoPosition = 0;
    commentsOpen = false;
    storyOpen = false;
    lightboxOpen = false;
    commentFeedback = '';
    if (updateHash && typeof window !== 'undefined') {
      window.history.replaceState(window.history.state, '', `#${data.days[position].date}`);
    }
    if (typeof window !== 'undefined') requestAnimationFrame(() => syncTrack(position));
  }
  function selectPhoto(i: number) {
    autoplay = false;
    photoPosition = i;
  }
  $effect(() => {
    const strip = photoThumbs;
    const selectedIndex = photoPosition;
    const dayId = currentDay?.id;
    if (!strip || !dayId || !compactGallery) return;
    let frame = 0;
    function centerThumbnail() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const thumbnail = strip!.children[selectedIndex] as HTMLElement | undefined;
        if (!thumbnail) return;
        const left = thumbnail.offsetLeft - (strip!.clientWidth - thumbnail.offsetWidth) / 2;
        if (Math.abs(strip!.scrollLeft - left) < 1) return;
        strip!.scrollTo({
          left,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
        });
      });
    }
    const observer = new ResizeObserver(centerThumbnail);
    observer.observe(strip);
    centerThumbnail();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  });
  function switchPhoto(shift: number, automatic = false) {
    if (!currentDay?.photos.length) return;
    if (!automatic) autoplay = false;
    photoPosition = (photoPosition + shift + currentDay.photos.length) % currentDay.photos.length;
  }
  function navigatePhoto(shift: -1 | 1) {
    autoplay = false;
    if (!currentDay) return;
    const nextPhoto = photoPosition + shift;
    if (nextPhoto >= 0 && nextPhoto < currentDay.photos.length) {
      photoPosition = nextPhoto;
      return;
    }
    const nextDay = position + shift;
    if (nextDay < 0 || nextDay >= data.days.length) return;
    const keepLightboxOpen = lightboxOpen;
    selectDay(nextDay);
    photoPosition = shift < 0 ? Math.max(0, data.days[nextDay].photos.length - 1) : 0;
    lightboxOpen = keepLightboxOpen && data.days[nextDay].photos.length > 0;
  }
  $effect(() => {
    // Une nouvelle photo ou journée dispose toujours de cinq secondes complètes.
    const photoId = currentPhoto?.id;
    if (!photoId || compactGallery || currentPhoto?.kind === 'video' || !autoplay || !pageVisible || commentsOpen || storyOpen || lightboxOpen || (currentDay?.photos.length ?? 0) < 2) return;
    const timer = window.setTimeout(() => switchPhoto(1, true), 5000);
    return () => window.clearTimeout(timer);
  });
  function onWheel(e: WheelEvent) {
    if (commentsOpen || storyOpen || lightboxOpen || !data.days.length) return;
    const closest = (e.target as HTMLElement).closest('input,textarea,select,video');
    if (closest) return;
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(delta) < 2) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel < 330) return;
    lastWheel = now;
    selectDay(position + Math.sign(delta));
  }
  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (e.key === 'Escape') {commentsOpen = false; storyOpen=false; lightboxOpen=false;return;}
    if (target?.closest('input,textarea,select,video,[contenteditable="true"]')) return;
    if (commentsOpen || storyOpen) return;
    if (e.key === 'ArrowRight') {e.preventDefault();navigatePhoto(1);}
    if (e.key === 'ArrowLeft') {e.preventDefault();navigatePhoto(-1);}
  }
  function focusDialog(node: HTMLDivElement) {
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not([tabindex="-1"]), textarea, a[href], video[controls]'));
    (focusable()[0] || node).focus();
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) { event.preventDefault(); node.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
    node.addEventListener('keydown', trapFocus);
    return { destroy() { node.removeEventListener('keydown', trapFocus); previousFocus?.focus(); } };
  }
  function startDrag(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return;
    dragging = true;
    moved = false;
    pointerStart = e.clientX;
    trackStart = track.scrollLeft;
  }
  function moveDrag(e: PointerEvent) {
    if (!dragging) return;
    if (Math.abs(e.clientX-pointerStart) > 5) moved = true;
    if (moved) {
      if (!track.hasPointerCapture(e.pointerId)) track.setPointerCapture(e.pointerId);
      track.scrollLeft = trackStart - (e.clientX - pointerStart);
    }
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    const midpoint = track.scrollLeft + track.clientWidth/2;
    let closest = 0;
    let distance = Infinity;
    track.querySelectorAll<HTMLElement>('[data-tick]').forEach(item => {
      const d = Math.abs(item.offsetLeft + item.offsetWidth/2 - midpoint);
      if (d<distance) {distance=d;closest=Number(item.dataset.tick);}
    });
    selectDay(closest);
    setTimeout(()=>{moved=false;},0);
  }
  async function submitComment(e: SubmitEvent) {
    e.preventDefault();
    if (!currentDay || submitting) return;
    commentFeedback = '';
    commentError = false;
    submitting = true;
    try {
      const response = await fetch('/api/comments', {
        method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({ dayId:currentDay.id, author:visitorName, message:visitorMessage, website:trap })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Erreur de réseau');
      commentFeedback = t.sent;
      visitorMessage = '';
    } catch(error) {
      commentFeedback = error instanceof Error ? error.message : 'Impossible d’envoyer le commentaire.';
      commentError = true;
    } finally {submitting=false;}
  }
  onMount(() => {
    const compactMedia = window.matchMedia('(max-width: 700px), (hover: none) and (pointer: coarse)');
    const updateCompactGallery = () => { compactGallery = compactMedia.matches; };
    updateCompactGallery();
    compactMedia.addEventListener('change', updateCompactGallery);
    autoplay = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const updateVisibility = () => { pageVisible = !document.hidden; };
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    const date = decodeURIComponent(window.location.hash.slice(1));
    const idx = data.days.findIndex(d=>d.date===date);
    selectDay(idx >= 0 ? idx : closestDayIndex(), false);
    // Écouteur non passif requis : la molette pilote la frise plutôt que le scroll classique.
    experience.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      compactMedia.removeEventListener('change', updateCompactGallery);
      experience.removeEventListener('wheel', onWheel);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  });
</script>

<svelte:head>
  <title>SereTiny — {t.tagline}</title>
  <meta name="description" content="Le journal photographique de la construction de SereTiny, une tiny house racontée jour après jour." />
</svelte:head>
<svelte:window onkeydown={onKey} />

<div class="experience" bind:this={experience} role="region" aria-label="SereTiny — Journal de construction">
  <div class="ambient-grain" aria-hidden="true"></div>
  <div class="journal-heading">
    <h1 class="journal-title">SereTiny</h1>
    <p class="journal-subtitle">{t.tagline}</p>
  </div>
  <div class="language-switch" role="group" aria-label="Langue / Language">
    <button type="button" class:active={language==='fr'} onclick={()=>language='fr'} aria-pressed={language==='fr'} lang="fr" aria-label="Français">fr</button>
    <span aria-hidden="true">/</span>
    <button type="button" class:active={language==='en'} onclick={()=>language='en'} aria-pressed={language==='en'} lang="en" aria-label="English">en</button>
  </div>

  <main class="stage">
    {#if currentDay}
      <section class="story-intro" aria-label="Journée du {prettyDate(currentDay.date)}">
        <div class="story-topline">
          <time datetime={currentDay.date}>{prettyDate(currentDay.date)}</time>
        </div>
        {#key currentDay.id}
          <div class="story-main" in:fly={{x:-26,duration:480,easing:cubicOut}}>
            {#if currentDay.chapter_id}<div class="chapter-number">{t.chapter} {String(chapterNumber).padStart(2,'0')}</div>{/if}
            <h2 class="day-title">{localized(currentDay.title_fr,currentDay.title_en) || prettyDate(currentDay.date)}</h2>
            <p class="chapter-name">{localized(currentDay.chapter_fr,currentDay.chapter_en)}</p>
            <div class="story-rule"></div>
            {#if localized(currentDay.body_fr,currentDay.body_en)}
              <p class="story-copy" bind:this={storyCopy}>{localized(currentDay.body_fr,currentDay.body_en)}</p>
              {#if storyOverflows}<button type="button" class="read-link" onclick={()=>storyOpen=true}>{t.read} <span>↗</span></button>{/if}
            {/if}
          </div>
        {/key}
        <div class="story-actions">
          <button type="button" class="comment-trigger" onclick={()=>commentsOpen=true}>{t.comments}{#if currentDay.comments.length} <span>({currentDay.comments.length})</span>{/if} <span aria-hidden="true">↗</span></button>
        </div>
      </section>
      <section class="photo-gallery" aria-label="Photos et vidéos du {prettyDate(currentDay.date)}">
        <div class="photo-frame">
          {#if currentPhoto}
            {#key currentPhoto.id}
              <div class="photo-print" in:fade={{duration:400}} out:fade={{duration:190}}>
                {#if currentPhoto.kind === 'video'}
                  <MediaVideo id={currentPhoto.id} label={localized(currentPhoto.caption_fr,currentPhoto.caption_en) || t.video}
                    active={pageVisible && !lightboxOpen && !commentsOpen && !storyOpen} onplay={() => autoplay = false} />
                {:else}
                  <img class="hero-image" src="/media/{currentPhoto.id}/large" alt={localized(currentPhoto.caption_fr,currentPhoto.caption_en) || t.captionFallback} />
                {/if}
              </div>
            {/key}
            {#if currentPhoto.kind !== 'video'}
            {#if currentDay.photos.length>1}
              <button class="photo-hit photo-hit-prev" type="button" onclick={()=>switchPhoto(-1)} aria-label={t.previousPhoto} title={t.previousPhoto}>
                <span aria-hidden="true"><svg viewBox="0 0 36 24" fill="none"><path d="M31 12.5 5 12M13 4.5 4.5 12l8 7.5" /></svg></span>
              </button>
            {/if}
            <button class="photo-hit photo-hit-expand" class:single-photo={currentDay.photos.length===1} type="button" onclick={()=>lightboxOpen=true} aria-label={t.expand} title={t.expand}></button>
            {#if currentDay.photos.length>1}
              <button class="photo-hit photo-hit-next" type="button" onclick={()=>switchPhoto(1)} aria-label={t.nextPhoto} title={t.nextPhoto}>
                <span aria-hidden="true"><svg viewBox="0 0 36 24" fill="none"><path d="m5 12.5 26-.5M23 4.5l8.5 7.5-8 7.5" /></svg></span>
              </button>
            {/if}
            {/if}
          {/if}
        </div>
        <div class="photo-controls">
          <p class="photo-caption">{localized(currentPhoto?.caption_fr,currentPhoto?.caption_en)}</p>
          <div class="gallery-nav">
            <span class="image-count">{String(photoPosition+1).padStart(2,'0')} / {String(currentDay.photos.length).padStart(2,'0')}</span>
            {#if currentDay.photos.length>1}
              <div class="photo-thumbs" bind:this={photoThumbs}>
                {#each currentDay.photos as photo, i (photo.id)}
                  <button type="button" class:chosen={photoPosition===i} onclick={()=>selectPhoto(i)} aria-label="{photo.kind === 'video' ? t.video : t.picture} {i+1}" aria-pressed={photoPosition===i}>
                    <img src="/media/{photo.id}/thumb" alt="" loading="lazy" />
                    {#if photo.kind === 'video'}<span class="video-mark" aria-hidden="true">▶</span>{/if}
                  </button>
                {/each}
              </div>
              {#if !compactGallery}<div class="arrows">
                <button type="button" onclick={()=>switchPhoto(-1)} aria-label={t.previousPhoto}>←</button>
                <button type="button" class="autoplay-toggle" onclick={()=>autoplay=!autoplay} aria-label={autoplay ? t.pause : t.play} title={autoplay ? t.pause : t.play}><span aria-hidden="true">{autoplay ? 'Ⅱ' : '▶'}</span></button>
                <button type="button" onclick={()=>switchPhoto(1)} aria-label={t.nextPhoto}>→</button>
              </div>{/if}
            {/if}
          </div>
        </div>
      </section>
    {:else}
      <section class="empty-stage" aria-label={t.tagline}>
        <svg class="house-sketch" viewBox="0 0 420 300" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m56 128 142-85 157 74M61 133l139-84 151 72M78 117l1 126 252-2-2-123M83 122l2 115 240-1M198 51l1 186M203 54l1 181M89 149l98-1m-98 24 98-2m-97 25 97-1m-96 24 96-2M219 142l39-1 1 48-40 1zM238 143v44m-18-22h37M277 163l33-1 1 74m-35-1 1-72M74 247l270-1M112 249c-21-3-27 31-6 34 22 6 26-30 6-34Zm181-1c-23-2-25 33-4 35 22 2 24-32 4-35Z" />
          <path d="m40 116-1 129m-7-126 14-3m-13 129 14-3M79 27l250-1m-248-7-3 16m252-16-2 15M19 257l351-1m-11-8 13 8-12 7M101 92l-10-17m235 19 11-18" stroke-opacity=".45" />
          <path d="m165 17 9 3-5 5m59-9-8 4 6 5" stroke-opacity=".65" />
        </svg>
        <p>{t.emptyHelp}</p>
      </section>
    {/if}
  </main>

  {#if currentDay}
  <nav class="timeline-shell" aria-label={t.timeline}>
    <div class="timeline-scroll" role="group" aria-label={t.timeline} bind:this={track} onpointerdown={startDrag} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag} class:dragging>
      {#if data.days.length}
        <div class="timeline-track">
          {#each data.days as day, i (day.id)}
            {@const newChapter = i===0 || day.chapter_id!==data.days[i-1].chapter_id}
            <button type="button" class="tick" class:current={position===i} class:first-of-chapter={newChapter} data-tick={i} onclick={()=>{if(!moved)selectDay(i);}} aria-pressed={position===i} aria-label="{prettyDate(day.date)}, {localized(day.title_fr,day.title_en)}">
              {#if newChapter}<span class="era-label">{localized(day.chapter_fr,day.chapter_en) || t.phase}</span>{/if}
              <span class="tick-line"><span class="tick-pin"></span></span>
              <span class="tick-date">{prettyDate(day.date,true)}</span>
              <span class="tick-title">{localized(day.title_fr,day.title_en)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="day-navigation">
      <button type="button" disabled={position===0} onclick={()=>selectDay(position-1)} aria-label={t.previous} title={t.previous}><svg viewBox="0 0 36 24" fill="none" aria-hidden="true"><path d="M31 12.5 5 12M13 4.5 4.5 12l8 7.5" /></svg></button>
      <span>{String(position+1).padStart(2,'0')} / {String(data.days.length).padStart(2,'0')}</span>
      <button type="button" disabled={position===data.days.length-1} onclick={()=>selectDay(position+1)} aria-label={t.next} title={t.next}><svg viewBox="0 0 36 24" fill="none" aria-hidden="true"><path d="m5 12.5 26-.5M23 4.5l8.5 7.5-8 7.5" /></svg></button>
    </div>
  </nav>
  {/if}
</div>

{#if commentsOpen && currentDay}
  <div class="dialog-backdrop" transition:fade={{duration:170}}>
    <button class="backdrop-hit" type="button" onclick={()=>commentsOpen=false} aria-label={t.close}></button>
    <div class="comment-drawer" role="dialog" aria-modal="true" aria-label={t.discussions} tabindex="-1" use:focusDialog transition:fly={{x:450,duration:260,easing:cubicOut}}>
      <div class="drawer-header"><div><span class="eyebrow">SERETINY / {prettyDate(currentDay.date)}</span><h2>{t.discussions}</h2></div><button type="button" class="round-close" onclick={()=>commentsOpen=false} aria-label={t.close}>×</button></div>
      <div class="comments-list">
        {#if currentDay.comments.length===0}<p class="no-comments">{t.noComments}</p>{/if}
        {#each currentDay.comments as comment (comment.id)}
          <article class="comment"><div class="comment-top"><strong>{comment.author}</strong><time datetime={comment.created_at}>{new Date(comment.created_at).toLocaleDateString(language==='fr'?'fr-FR':'en-GB')}</time></div><p>{comment.body}</p></article>
        {/each}
      </div>
      <form class="comment-form" onsubmit={submitComment}>
        <h3>{t.commentsIntro}</h3>
        <label>{t.name}<input name="author" type="text" bind:value={visitorName} minlength="2" maxlength="60" required /></label>
        <label>{t.message}<textarea name="message" bind:value={visitorMessage} minlength="3" maxlength="1000" rows="3" required></textarea></label>
        <div class="trap" aria-hidden="true"><label>Site web<input type="text" name="website" bind:value={trap} tabindex="-1" autocomplete="off" /></label></div>
        <button class="send-comment" type="submit" disabled={submitting}>{submitting?'…':t.send} <span>↗</span></button>
        <small>{t.moderation}</small>
        {#if commentFeedback}<p class:feedback-error={commentError} class="feedback" role="status">{commentFeedback}</p>{/if}
      </form>
    </div>
  </div>
{/if}

{#if storyOpen && currentDay}
  <div class="dialog-backdrop" transition:fade={{duration:170}}>
    <button class="backdrop-hit" type="button" onclick={()=>storyOpen=false} aria-label={t.close}></button>
    <div class="story-dialog" role="dialog" aria-modal="true" aria-label={t.story} tabindex="-1" use:focusDialog transition:fly={{y:36,duration:250}}>
      <button type="button" class="round-close" onclick={()=>storyOpen=false} aria-label={t.close}>×</button>
      <div class="eyebrow">{prettyDate(currentDay.date)} · {localized(currentDay.chapter_fr,currentDay.chapter_en)}</div>
      <h2>{localized(currentDay.title_fr,currentDay.title_en)}</h2>
      <p>{localized(currentDay.body_fr,currentDay.body_en)}</p>
      <button type="button" class="read-link" onclick={()=>storyOpen=false}>← {t.back}</button>
    </div>
  </div>
{/if}

{#if lightboxOpen && currentDay && currentPhoto}
  <div class="lightbox" role="dialog" aria-modal="true" aria-label={t.photoCaption} tabindex="-1" use:focusDialog transition:fade={{duration:180}}>
    <div class="lightbox-header"><span>SERETINY · {prettyDate(currentDay.date)}</span><button type="button" onclick={()=>lightboxOpen=false} aria-label={t.close}>×</button></div>
    <div class="lightbox-content"><button type="button" onclick={()=>switchPhoto(-1)} aria-label={t.previousPhoto} disabled={currentDay.photos.length===1}>←</button>
      {#key currentPhoto.id}
        {#if currentPhoto.kind === 'video'}
          <div class="lightbox-video"><MediaVideo id={currentPhoto.id} label={localized(currentPhoto.caption_fr,currentPhoto.caption_en)||t.video} active={pageVisible} /></div>
        {:else}<img src="/media/{currentPhoto.id}/large" alt={localized(currentPhoto.caption_fr,currentPhoto.caption_en)||t.captionFallback} />{/if}
      {/key}
      <button type="button" onclick={()=>switchPhoto(1)} aria-label={t.nextPhoto} disabled={currentDay.photos.length===1}>→</button></div>
    <p>{localized(currentPhoto.caption_fr,currentPhoto.caption_en)||t.captionFallback} <span>{photoPosition+1} / {currentDay.photos.length}</span></p>
    <button class="lightbox-backdrop" type="button" onclick={()=>lightboxOpen=false} aria-label={t.close}></button>
  </div>
{/if}

<style>
.experience {
  --ink: #354c57;
  --pencil: #64747a;
  --copper: #986447;
  --paper: #eeeadd;
  position: relative;
  isolation: isolate;
  height: 100dvh;
  width: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  color: var(--ink);
  background-color: var(--paper);
  background-image: linear-gradient(#708a9620 1px, transparent 1px), linear-gradient(90deg, #708a9620 1px, transparent 1px), linear-gradient(#708a960a 1px, transparent 1px), linear-gradient(90deg, #708a960a 1px, transparent 1px);
  background-size: 120px 120px, 120px 120px, 24px 24px, 24px 24px;
  background-position: -1px -1px;
}
.ambient-grain { position: absolute; z-index: -1; inset: 0; pointer-events: none; opacity: .42; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Cpath fill='%237a6a50' opacity='.23' filter='url(%23n)' d='M0 0h180v180H0z'/%3E%3C/svg%3E"); }
.journal-heading { flex-shrink: 0; padding: 18px clamp(28px, 6vw, 100px) 0; }
.journal-title { width: fit-content; margin: 0; padding: 0 .14em .06em 0; color: var(--ink); font: 500 46px/1.1 'Caveat', 'Segoe Print', cursive; letter-spacing: -.035em; transform: rotate(-1deg); }
.journal-subtitle { margin: 0; color: var(--pencil); font: 20px/1.2 'Caveat', 'Segoe Print', cursive; }
.language-switch { position: absolute; z-index: 5; right: clamp(22px, 4vw, 64px); top: 16px; display: flex; align-items: center; gap: 5px; color: var(--pencil); font: 20px 'Caveat', cursive; }
.language-switch button { background: none; border: 0; color: inherit; padding: 6px; min-width: 36px; min-height: 40px; }
.language-switch button.active { color: var(--ink); text-decoration: underline; text-underline-offset: 5px; text-decoration-style: wavy; text-decoration-thickness: 1px; }
.stage { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(230px, .8fr) minmax(0, 1.65fr); align-items: center; gap: clamp(30px, 6vw, 100px); padding: 26px clamp(28px, 6vw, 100px) 28px; }
.story-intro { display: flex; flex-direction: column; justify-content: center; min-width: 0; min-height: 0; max-width: 440px; max-height: 100%; }
.story-topline { font: 12px ui-monospace, 'Courier New', monospace; color: var(--pencil); transform: rotate(-2deg); }
.story-topline time { display: inline-block; border-bottom: 1px solid #64747a60; padding-bottom: 7px; }
.story-main { margin-top: clamp(18px, 3vh, 32px); position: relative; min-height: 0; display: flex; flex-direction: column; }
.chapter-number { font: 21px 'Caveat', cursive; color: var(--copper); transform: rotate(-3deg); transform-origin: left; }
.day-title { font: 500 clamp(43px, 4.7vw, 76px)/.98 'Caveat', 'Segoe Print', cursive; letter-spacing: -.035em; margin: 12px 0 17px; text-wrap: balance; transform: rotate(-1deg); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; flex-shrink: 0; }
.chapter-name { font: 24px/1.15 'Caveat', cursive; color: var(--copper); margin: 0 0 23px; }
.chapter-name:empty { display: none; }
.story-rule { width: 80px; height: 5px; flex-shrink: 0; border-top: 1px solid #64747a80; border-radius: 50%; transform: rotate(-3deg); margin: 0 0 22px; }
.story-copy { font-size: 13px; line-height: 1.9; margin: 0; min-height: 0; max-width: 355px; white-space: pre-line; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; line-clamp: 5; overflow: hidden; }
.read-link, .comment-trigger { background: none; border: 0; color: var(--ink); padding: 8px 0; font: 22px 'Caveat', cursive; }
.read-link { align-self: flex-start; flex-shrink: 0; margin-top: 10px; text-decoration: underline; text-underline-offset: 5px; text-decoration-thickness: 1px; }
.read-link span { display: inline-block; margin-left: 8px; }
.read-link:hover, .comment-trigger:hover { color: var(--copper); }
.story-actions { flex-shrink: 0; margin-top: clamp(15px, 3vh, 30px); }
.comment-trigger { color: var(--pencil); transform: rotate(-2deg); }
.comment-trigger span { margin-left: 4px; }
.photo-gallery { position: relative; display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; padding-top: 5px; transform: rotate(.8deg); }
.photo-frame {
  position: relative;
  flex: 1;
  min-height: 0;
  border: 9px solid transparent;
  border-radius: 3px 7px 5px 2px;
  background-color: #f4eddf;
  background-image: url('/photo-paper.svg'), radial-gradient(ellipse at 22% 16%, #fffdf5cc, transparent 64%), linear-gradient(135deg, #f4eddf, #e6dbc7);
  background-size: 256px 256px, 100% 100%, 100% 100%;
  background-clip: border-box;
  box-shadow: 0 1px 2px #fffdf5cc inset, 0 -2px 7px #947b5020 inset, 1px 2px 3px #493a2421, 4px 10px 22px #493a241c;
}
.photo-frame::before, .photo-frame::after { content: ''; position: absolute; z-index: 4; top: -17px; width: 89px; height: 27px; background: #c4ae7d78; border-left: 2px dotted #eeeaddaa; border-right: 2px dotted #eeeaddaa; pointer-events: none; }
.photo-frame::before { left: 11%; transform: rotate(-8deg); }
.photo-frame::after { right: 9%; transform: rotate(6deg); }
.photo-print { position: absolute; inset: clamp(2px, .5vw, 8px); display: flex; align-items: center; justify-content: center; pointer-events: none; }
.photo-thumbs button { position:relative; }
.video-mark { position:absolute; inset:0; display:grid; place-items:center; color:white; text-shadow:0 1px 4px #000; pointer-events:none; }
.lightbox-video { width:calc(100% - 90px); height:100%; min-height:0; pointer-events:auto; }
.hero-image {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  -webkit-mask: url('/photo-brush-mask-subtle.png') center / 100% 100% no-repeat;
  mask: url('/photo-brush-mask-subtle.png') center / 100% 100% no-repeat;
  mask-mode: alpha;
}
.photo-hit { position: absolute; z-index: 2; top: 0; bottom: 0; width: 25%; border: 0; padding: 0 14px; background: transparent; color: var(--copper); display: flex; align-items: center; }
.photo-hit-prev { left: 0; }
.photo-hit-next { right: 0; justify-content: flex-end; }
.photo-hit-expand { left: 25%; width: 50%; cursor: zoom-in; }
.photo-hit-expand.single-photo { left: 0; width: 100%; }
.photo-hit span { display: grid; place-items: center; flex-shrink: 0; width: 54px; height: 44px; border: 1px solid #98644740; border-radius: 2px 5px 3px 2px; background: #f4eddf url('/photo-paper.svg') center / 256px; box-shadow: 0 1px 0 #fffdf5b3 inset, 1px 3px 8px #493a2426; opacity: 0; transform: translateX(-6px) rotate(-3deg); transition: opacity .2s, transform .2s, color .2s, box-shadow .2s; }
.photo-hit-next span { transform: translateX(6px) rotate(3deg); border-radius: 5px 2px 2px 3px; }
.photo-hit svg, .day-navigation svg { width: 32px; height: 24px; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.photo-hit:hover span, .photo-hit:focus-visible span { opacity: 1; transform: translateX(0) rotate(-3deg); }
.photo-hit-next:hover span, .photo-hit-next:focus-visible span { transform: translateX(0) rotate(3deg); }
.photo-hit:hover span { color: var(--ink); box-shadow: 0 1px 0 #fffdf5b3 inset, 1px 4px 10px #493a2438; }
.photo-controls { display: grid; flex-shrink: 0; gap: 8px; padding: 12px 5px 0; }
.photo-caption { margin: 0; min-width: 0; font: 23px/1.2 'Caveat', cursive; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; }
.photo-caption:empty { display: none; }
.gallery-nav { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; min-width: 0; }
.image-count { color: var(--pencil); font: 11px ui-monospace, monospace; white-space: nowrap; }
.photo-thumbs { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; min-width: 0; padding: 3px; }
.photo-thumbs button { flex: 0 0 44px; height: 44px; padding: 2px; border: 1px solid transparent; background: #faf7ee; opacity: .6; transform: rotate(-3deg); }
.photo-thumbs button:nth-child(even) { transform: rotate(3deg); }
.photo-thumbs button.chosen { opacity: 1; border-color: var(--copper); }
.photo-thumbs img { width: 100%; height: 100%; object-fit: contain; }
.arrows { display: flex; gap: 3px; }
.arrows button { background: transparent; border: 0; color: var(--ink); width: 44px; height: 44px; font: 30px 'Caveat', cursive; }
.arrows .autoplay-toggle { font: 16px ui-sans-serif, sans-serif; }
.arrows button:hover, .day-navigation button:hover:enabled { color: var(--copper); }
.empty-stage { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; text-align: center; max-width: 650px; margin: auto; }
.house-sketch { width: min(400px, 65vw); max-height: 40dvh; color: var(--ink); transform: rotate(-2deg); }
.empty-stage p { max-width: 320px; color: var(--pencil); font-size: 13px; line-height: 1.9; margin: 0; }
.timeline-shell { position: relative; flex-shrink: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 16px; height: 153px; margin: 0 clamp(22px, 4vw, 64px) 18px; padding-top: 3px; }
.timeline-shell::before { position: absolute; content: ''; inset: 0 0 auto; height: 4px; border-top: 1px solid #64747a55; border-radius: 50%; transform: rotate(-.25deg); }
.day-navigation { position: relative; align-self: start; display: flex; align-items: center; gap: 5px; margin-top: 55px; font: 11px ui-monospace, monospace; color: var(--pencil); }
.day-navigation::before { content: ''; position: absolute; top: -9px; left: -16px; right: 0; border-top: 1px solid #536975b0; transform: rotate(-.15deg); pointer-events: none; }
.day-navigation button { display: grid; place-items: center; background: transparent; border: 0; padding: 0; color: var(--ink); width: 44px; height: 44px; transition: color .2s, transform .2s; }
.day-navigation button:hover:enabled { transform: translateX(-2px); }
.day-navigation button:last-child:hover:enabled { transform: translateX(2px); }
.day-navigation span { white-space: nowrap; }
.day-navigation button:disabled { opacity: .25; cursor: default; }
.timeline-scroll { min-width: 0; height: 100%; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; cursor: grab; touch-action: pan-x; overscroll-behavior-x: contain; }
.timeline-scroll::-webkit-scrollbar { display: none; }
.timeline-scroll.dragging { cursor: grabbing; user-select: none; }
.timeline-track { position: relative; display: flex; min-width: 100%; width: max-content; height: 100%; padding: 0 max(40px, calc(35vw - 130px)); }
.timeline-track::before { position: absolute; content: ''; left: 0; right: 0; top: 46px; height: 3px; border-top: 1px solid #536975b0; border-bottom: 1px solid #53697520; border-radius: 45%; transform: rotate(-.15deg); pointer-events: none; }
.tick { background: none; border: 0; color: var(--pencil); width: 165px; flex: 0 0 165px; position: relative; text-align: left; padding: 0 13px; display: flex; flex-direction: column; align-items: flex-start; }
.tick.current { color: var(--ink); }
.era-label { font: 20px 'Caveat', cursive; color: var(--copper); position: absolute; top: 3px; left: 13px; white-space: nowrap; transform: rotate(-3deg); }
.first-of-chapter::after { content: ''; position: absolute; top: 28px; left: 17px; height: 19px; border-left: 1px dashed var(--copper); }
.tick-line { height: 91px; flex-shrink: 0; display: flex; align-items: center; padding-left: 1px; }
.tick-pin { width: 8px; height: 8px; border: 1px solid #64747a; border-radius: 46% 53% 48% 41%; background: var(--paper); z-index: 1; }
.tick.current .tick-pin { background: var(--copper); border-color: var(--copper); outline: 1px solid var(--copper); outline-offset: 4px; transform: rotate(-15deg); }
.tick-date { font: 24px/1 'Caveat', cursive; white-space: nowrap; margin-top: -23px; }
.tick.current .tick-date { text-decoration: underline; text-decoration-style: wavy; text-decoration-thickness: 1px; text-underline-offset: 5px; }
.tick-title { font-size: 10px; line-height: 1.5; margin-top: 12px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dialog-backdrop { position: fixed; z-index: 50; inset: 0; background: #273a4370; display: flex; justify-content: flex-end; }
.backdrop-hit { position: absolute; inset: 0; background: transparent; border: 0; width: 100%; height: 100%; cursor: default; }
.comment-drawer, .story-dialog { position: relative; z-index: 1; background-color: #f3efe3; background-image: repeating-linear-gradient(transparent 0 31px, #708a9610 31px 32px); color: #354c57; box-shadow: -8px 0 30px #273a4322; }
.comment-drawer { width: min(100%, 480px); height: 100%; overflow: auto; display: flex; flex-direction: column; padding: 35px clamp(25px, 3vw, 42px); border-left: 1px dashed #64747a60; }
.drawer-header { display: flex; justify-content: space-between; gap: 12px; }
.eyebrow { color: #6d787b; font: 11px ui-monospace, monospace; }
.drawer-header h2, .story-dialog h2 { font: 500 44px/1.05 'Caveat', cursive; margin: 12px 0; }
.round-close { width: 42px; height: 42px; flex-shrink: 0; border: 1px solid #64747a90; border-radius: 48% 43% 51% 46%; background: none; color: #354c57; font-size: 25px; }
.drawer-intro { font-size: 13px; line-height: 1.7; color: #64747a; }
.comments-list { padding: 10px 0 15px; flex: 1; min-height: 80px; }
.no-comments { font: 24px 'Caveat', cursive; color: #64747a; margin: 35px 0; }
.comment { border-top: 1px dashed #64747a55; padding: 18px 0; }
.comment-top { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.comment time { font-size: 10px; color: #64747a; }
.comment p { font-size: 13px; line-height: 1.7; white-space: pre-line; }
.comment-form { border-top: 1px dashed #64747a70; padding-top: 20px; display: grid; gap: 11px; }
.comment-form h3 { font: 24px 'Caveat', cursive; margin: 0 0 6px; }
.comment-form label { display: grid; gap: 6px; font-size: 12px; }
.comment-form input, .comment-form textarea { width: 100%; border: 1px solid #64747a70; border-radius: 2px 5px 3px 4px; background: #fffdf580; color: #354c57; padding: 10px; font-size: 14px; }
.comment-form textarea { resize: vertical; }
.comment-form .trap { position: absolute; width: 1px; height: 1px; overflow: hidden; left: -9000px; }
.send-comment { background: #354c57; color: #f3efe3; border: 0; border-radius: 3px 6px 2px 5px; padding: 12px 16px; font: 24px 'Caveat', cursive; display: flex; justify-content: space-between; }
.send-comment:disabled { opacity: .6; }
.comment-form small { color: #64747a; font-size: 11px; }
.feedback { color: #396448; font-size: 12px; }
.feedback-error { color: #9b432d; }
.story-dialog { align-self: center; margin: auto; max-height: 90dvh; overflow-y: auto; width: min(780px, calc(100% - 35px)); padding: clamp(28px, 5vw, 68px); border-radius: 3px 7px 2px 4px; }
.story-dialog .round-close { position: absolute; right: 18px; top: 18px; }
.story-dialog .eyebrow { padding-right: 40px; line-height: 1.8; }
.story-dialog h2 { font-size: clamp(38px, 5vw, 64px); margin: 25px 0; }
.story-dialog p { white-space: pre-line; font-size: 15px; line-height: 1.95; max-width: 640px; }
.story-dialog .read-link { color: #986447; margin-top: 24px; }
.lightbox { position: fixed; z-index: 60; inset: 0; background: #23343bf5; color: #eeeadd; display: flex; flex-direction: column; padding: 20px clamp(16px, 4vw, 70px); }
.lightbox-backdrop { position: absolute; z-index: 0; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-out; }
.lightbox-header, .lightbox-content, .lightbox p { position: relative; z-index: 1; pointer-events: none; }
.lightbox-header button, .lightbox-header span, .lightbox-content button, .lightbox-content img, .lightbox p { pointer-events: auto; }
.lightbox-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; font: 11px ui-monospace, monospace; }
.lightbox-header button { background: none; border: 0; color: inherit; width: 44px; height: 44px; font-size: 32px; }
.lightbox-content { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; gap: 8px; }
.lightbox-content img { max-width: calc(100% - 90px); max-height: 100%; object-fit: contain; }
.lightbox-content button { flex-shrink: 0; width: 36px; height: 44px; background: none; color: inherit; border: 0; font: 30px 'Caveat', cursive; }
.lightbox-content button:disabled { visibility: hidden; }
.lightbox p { display: flex; gap: 20px; justify-content: center; font: 24px 'Caveat', cursive; }
.lightbox p span { opacity: .6; white-space: nowrap; }
@media (max-width: 1050px) {
  .stage { gap: 30px; grid-template-columns: minmax(215px, .85fr) minmax(0, 1.35fr); }
  .gallery-nav { grid-template-columns: 1fr auto; gap: 5px; }
  .photo-thumbs { grid-column: 1 / -1; grid-row: 2; }
  .arrows { grid-column: 2; grid-row: 1; }
  .story-copy { -webkit-line-clamp: 4; line-clamp: 4; }
}
@media (max-width: 700px) {
  .journal-heading { padding: 12px 25px 0; }
  .journal-title { font-size: 36px; }
  .journal-subtitle { font-size: 18px; }
  .language-switch { top: 7px; right: 16px; }
  .stage { display: flex; flex-direction: column; align-items: stretch; gap: 20px; padding: 20px 25px 14px; }
  .story-intro { flex: 0 0 auto; max-width: none; position: relative; padding-right: 3px; }
  .story-topline { font-size: 10px; }
  .story-main { margin-top: 12px; }
  .chapter-number { display: none; }
  .day-title { font-size: clamp(35px, 8.5vw, 52px); line-height: .98; margin: 5px 0 8px; -webkit-line-clamp: 2; line-clamp: 2; }
  .chapter-name { font-size: 22px; margin-bottom: 0; padding-right: 110px; }
  .story-rule, .story-copy { display: none; }
  .story-main .read-link { font-size: 20px; margin-top: 2px; padding-bottom: 0; }
  .story-actions { position: absolute; right: 0; bottom: -1px; margin: 0; }
  .comment-trigger { font-size: 19px; }
  .photo-gallery { flex: 1; min-height: 0; }
  .photo-frame { border-width: 6px; }
  .photo-frame::before, .photo-frame::after { width: 63px; height: 21px; top: -14px; }
  .photo-controls { padding-top: 8px; gap: 9px; }
  .photo-caption { font-size: 21px; -webkit-line-clamp: 2; line-clamp: 2; }
  .image-count { font-size: 10px; }
  .arrows { gap: 0; }
  .timeline-shell { height: 133px; margin: 26px 18px 9px; }
  .timeline-shell { column-gap: 8px; }
  .day-navigation { gap: 0; font-size: 10px; }
  .day-navigation::before { left: -8px; }
  .day-navigation button { width: 36px; }
  .day-navigation svg { width: 26px; }
  .photo-hit { padding-inline: 7px; }
  .photo-hit span { width: 44px; }
  .timeline-track { padding: 0 38vw; }
  .tick { width: 140px; flex-basis: 140px; }
  .tick-date { font-size: 23px; }
  .tick-title { max-width: 115px; }
  .era-label { font-size: 19px; }
  .empty-stage { margin: auto; }
  .empty-stage p { max-width: 280px; }
  .drawer-header h2 { font-size: 37px; }
}
@media (max-height: 680px) and (min-width: 701px) {
  .stage { padding-top: 20px; padding-bottom: 19px; }
  .story-main { margin-top: 15px; }
  .day-title { font-size: clamp(38px, 4.7vw, 64px); }
  .story-copy { -webkit-line-clamp: 3; line-clamp: 3; }
  .story-actions { margin-top: 8px; }
  .chapter-name { margin-bottom: 12px; }
  .story-rule { margin-bottom: 12px; }
  .timeline-shell { height: 135px; margin-bottom: 6px; }
}
@media (max-height: 620px) and (max-width: 700px) {
  .journal-heading { padding-top: 8px; }
  .journal-title { font-size: 30px; }
  .journal-subtitle { font-size: 16px; }
  .stage { padding-top: 16px; gap: 14px; }
  .day-title { font-size: 34px; }
  .chapter-name { font-size: 19px; }
  .timeline-shell { height: 115px; margin-top: 20px; margin-bottom: 0; }
  .tick-title { display: none; }
  .photo-caption { -webkit-line-clamp: 1; line-clamp: 1; }
}
@media (max-height: 480px) and (min-width: 701px) {
  .journal-heading { display: flex; align-items: baseline; gap: 18px; padding-top: 9px; padding-right: 130px; }
  .journal-title { font-size: 32px; }
  .journal-subtitle { font-size: 18px; }
  .stage { padding-top: 18px; padding-bottom: 12px; }
  .story-main { margin-top: 8px; }
  .chapter-number, .story-rule, .story-copy { display: none; }
  .day-title { font-size: 38px; -webkit-line-clamp: 2; line-clamp: 2; margin: 5px 0 8px; }
  .chapter-name { font-size: 21px; margin-bottom: 0; }
  .read-link, .comment-trigger { font-size: 20px; padding: 4px 0; margin-top: 0; }
  .story-actions { margin-top: 4px; }
  .timeline-shell { height: 115px; }
  .tick-title { display: none; }
  .photo-caption { -webkit-line-clamp: 1; line-clamp: 1; font-size: 20px; }
}
@media (hover: none) {
  .photo-hit span { opacity: .9; transform: rotate(-3deg); }
  .photo-hit-next span { transform: rotate(3deg); }
}
@media (max-width: 700px), (hover: none) and (pointer: coarse) {
  .story-topline { display: none; }
  .story-main { margin-top: 0; }
  .gallery-nav { grid-template-columns: auto minmax(0, 1fr); gap: 10px; }
  .photo-thumbs { position: relative; grid-column: 2; grid-row: 1; flex-wrap: nowrap; justify-content: flex-start; gap: 8px; height: 64px; padding: 5px 3px 7px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; touch-action: pan-x; scroll-snap-type: x proximity; scrollbar-width: none; }
  /* Leave enough room to center the first and last thumbnails, including the 8px gap. */
  .photo-thumbs::before, .photo-thumbs::after { content: ''; flex: 0 0 max(0px, calc(50% - 34px)); }
  .photo-thumbs::-webkit-scrollbar { display: none; }
  .photo-thumbs button, .photo-thumbs button:nth-child(even) { flex-basis: 52px; height: 52px; transform: none; scroll-snap-align: center; }
  .photo-thumbs button:focus-visible { outline: 1px solid var(--ink); outline-offset: 1px; }
  .photo-thumbs img { object-fit: cover; }
  .photo-hit span { opacity: .9; transform: rotate(-3deg); }
  .photo-hit-next span { transform: rotate(3deg); }
  .arrows, .day-navigation { display: none; }
  .timeline-shell { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
</style>
