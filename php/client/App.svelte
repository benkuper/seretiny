<script lang="ts">
  import Public from '../../src/routes/+page.svelte';
  import Admin from '../../src/routes/admin/+page.svelte';
  import Login from '../../src/routes/admin/login/+page.svelte';
  import type { Bootstrap } from './main';
  import { untrack } from 'svelte';
  let { initial }: { initial: Bootstrap } = $props();
  let data = $state(untrack(() => initial.data));
  let form = $state(untrack(() => initial.form));
  async function refresh() {
    const response = await fetch(location.pathname + location.search, {headers: {Accept: 'application/json'}});
    if (response.status === 401) { location.href = initial.base + '/admin/login'; return; }
    if (!response.ok) throw new Error('Actualisation impossible.');
    const next = await response.json(); data = next.data; form = next.form;
  }
  $effect(() => {
    const handler = (event: Event) => { void refresh().catch(() => location.reload()).finally(() => (event as CustomEvent<() => void>).detail?.()); };
    window.addEventListener('seretiny:refresh', handler);
    return () => window.removeEventListener('seretiny:refresh', handler);
  });
</script>

{#if initial.page === 'admin'}<Admin {data} {form} />
{:else if initial.page === 'login'}<Login {data} {form} />
{:else}<Public {data} />{/if}
