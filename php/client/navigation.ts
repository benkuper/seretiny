export async function invalidateAll() {
  await new Promise<void>((resolve) => window.dispatchEvent(new CustomEvent('seretiny:refresh', {detail: resolve})));
}
