<script lang="ts">
  let {id, label, active = true, onplay}: {
    id: string; label: string; active?: boolean; onplay?: () => void;
  } = $props();
  let video = $state<HTMLVideoElement>();
  $effect(() => { if (!active) video?.pause(); });
  $effect(() => {
    const element = video;
    return () => element?.pause();
  });
</script>

<!-- svelte-ignore a11y_media_has_caption (Personal journal clips have editorial captions; no timed transcript is supplied.) -->
<video class="media-video" bind:this={video} src="/media/{id}/video" poster="/media/{id}/large"
  controls playsinline preload="none" aria-label={label} {onplay}>
  <a href="/media/{id}/video">{label}</a>
</video>

<style>
  video { display:block; width:100%; height:100%; max-width:100%; max-height:100%; object-fit:contain; background:#181613; pointer-events:auto; }
</style>
