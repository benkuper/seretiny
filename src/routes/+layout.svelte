<script lang="ts">
  import '../app.css';
  import caveatLatinUrl from '#lib/assets/fonts/caveat-latin.woff2?url';
  let { children } = $props();
</script>
<svelte:head><link rel="preload" href={caveatLatinUrl} as="font" type="font/woff2" crossorigin="anonymous" /></svelte:head>
{@render children()}
