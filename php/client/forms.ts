import type { SubmitFunction } from '$app/forms';
import { invalidateAll } from './navigation';

export function enhance(form: HTMLFormElement, submit?: SubmitFunction) {
  async function handler(event: SubmitEvent) {
    event.preventDefault();
    let cancelled = false;
    const data = new FormData(form);
    const callback = await submit?.({action: new URL(form.action), formData: data, formElement: form,
      controller: new AbortController(), submitter: event.submitter as HTMLButtonElement, cancel: () => { cancelled = true; }});
    if (cancelled) return;
    let result: any;
    try {
      const response = await fetch(form.action, {method: 'POST', body: data, headers: {Accept: 'application/json'}});
      result = await response.json();
    } catch { result = {type: 'error', status: 500, error: {message: 'Connexion interrompue.'}}; }
    const update = async () => {
      if (result.type === 'redirect') location.href = result.location;
      else if (result.type === 'success') await invalidateAll();
    };
    if (callback) await callback({result, update, formData: data, formElement: form, action: new URL(form.action)});
    else await update();
  }
  form.addEventListener('submit', handler);
  return {destroy() { form.removeEventListener('submit', handler); }};
}
