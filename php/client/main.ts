import { mount } from 'svelte';
import App from './App.svelte';
import '../../src/app.css';

export type Bootstrap = { page: 'public' | 'admin' | 'login'; data: any; form: any; csrf: string; base: string };
export const bootstrap: Bootstrap = JSON.parse(document.getElementById('seretiny-data')!.textContent!);
document.addEventListener('submit', (event) => {
  const form = event.target as HTMLFormElement;
  if (form.method.toLowerCase() !== 'post') return;
  if (new URL(form.action).origin !== location.origin) return;
  let input = form.querySelector<HTMLInputElement>('input[name="_csrf"]');
  if (!input) { input = document.createElement('input'); input.name = '_csrf'; input.type = 'hidden'; form.append(input); }
  input.value = bootstrap.csrf;
  // PHP requires brackets to preserve repeated multipart fields.
  for (const field of form.querySelectorAll<HTMLInputElement>('input[name="photos"],input[name="ids"]')) field.name += '[]';
}, true);
mount(App, {target: document.getElementById('app')!, props: {initial: bootstrap}});
