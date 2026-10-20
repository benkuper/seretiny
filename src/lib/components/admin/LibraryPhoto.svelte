<script lang="ts">
  import { enhance } from '$app/forms';
  import { tick } from 'svelte';
  import type { SubmitFunction } from '$app/forms';
  import type { Photo } from '#lib/types.js';

  let { photo, date, dayId, selected, list = false, onselect, onpreview }: {
    photo: Photo;
    date: string;
    dayId: number;
    selected: boolean;
    list?: boolean;
    onselect: (checked: boolean) => void;
    onpreview: () => void;
  } = $props();

  let editing = $state<'caption' | 'date' | null>(null);
  let captionDraft = $state('');
  let dateDraft = $state('');
  let saving = $state(false);
  let deleting = $state(false);
  let error = $state('');
  let feedback = $state('');
  let captionButton = $state<HTMLButtonElement>();
  let dateButton = $state<HTMLButtonElement>();
  let formattedDate = $derived(new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(`${date}T12:00:00Z`)));

  function startEdit(kind: 'caption' | 'date') {
    if (saving || deleting) return;
    captionDraft = photo.caption_fr;
    dateDraft = date;
    editing = kind;
    error = '';
    feedback = '';
  }

  async function cancelEdit() {
    const previous = editing;
    editing = null;
    error = '';
    await tick();
    (previous === 'caption' ? captionButton : dateButton)?.focus();
  }

  function focusEditor(node: HTMLInputElement | HTMLTextAreaElement) {
    node.focus();
    if (node instanceof HTMLTextAreaElement) node.select();
  }

  function editorKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && !saving) {
      event.preventDefault();
      void cancelEdit();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).form?.requestSubmit();
    }
  }

  const save: SubmitFunction = () => {
    saving = true;
    error = '';
    feedback = '';
    return async ({result, update}) => {
      try {
        if (result.type === 'failure') {
          error = String(result.data?.message || 'Modification impossible.');
        } else if (result.type === 'error') {
          error = 'Enregistrement impossible. Réessaie.';
        } else {
          const previous = editing;
          editing = null;
          await update({reset: false, navigate: false});
          feedback = 'Enregistré.';
          (previous === 'caption' ? captionButton : dateButton)?.focus();
        }
      } finally { saving = false; }
    };
  };

  const remove: SubmitFunction = ({cancel}) => {
    if (!window.confirm('Supprimer définitivement cette photo ? Cette action est irréversible.')) {
      cancel();
      return;
    }
    deleting = true;
    error = '';
    return async ({result, update}) => {
      try {
        if (result.type === 'failure' || result.type === 'error') error = 'Suppression impossible. Réessaie.';
        else await update({reset: false, navigate: false});
      } finally { deleting = false; }
    };
  };
</script>

<article class="library-card" class:list class:selected aria-busy={saving || deleting}>
  <div class="image-area">
    <label class="library-select"><input type="checkbox" checked={selected} onchange={(event) => onselect(event.currentTarget.checked)} aria-label="Sélectionner la photo du {formattedDate}{photo.caption_fr ? ` : ${photo.caption_fr}` : ''}" /></label>
    <button class="library-image" type="button" onclick={onpreview} aria-label="Voir en grand la photo du {formattedDate}"><img src="/media/{photo.id}/thumb" alt={photo.caption_fr || `Photo du ${formattedDate}`} loading="lazy" /></button>
    <a class="edit-photo" href="/admin?day={dayId}#photo-{photo.id}" title="Ouvrir la fiche complète" aria-label="Modifier les détails de la photo du {formattedDate}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z" /></svg></a>
  </div>
  <div class="library-meta">
    {#if editing === 'date'}
      <form method="POST" action="?/editLibraryPhoto&view=photos" use:enhance={save}>
        <input type="hidden" name="id" value={photo.id} /><input type="hidden" name="edit" value="date" />
        <label>Date d’affichage<input name="date" type="date" bind:value={dateDraft} required disabled={saving} onkeydown={editorKey} use:focusEditor /></label>
        <div class="editor-actions"><button class="save" disabled={saving}>{saving ? 'Enregistrement…' : 'Enregistrer'}</button><button type="button" onclick={cancelEdit} disabled={saving}>Annuler</button></div>
      </form>
    {:else}
      <button bind:this={dateButton} class="inline-date editable" type="button" onclick={() => startEdit('date')} title="Modifier la date">{formattedDate}</button>
    {/if}
    {#if editing === 'caption'}
      <form method="POST" action="?/editLibraryPhoto&view=photos" use:enhance={save}>
        <input type="hidden" name="id" value={photo.id} /><input type="hidden" name="edit" value="caption" />
        <label>Légende française<textarea name="caption_fr" rows="3" maxlength="500" bind:value={captionDraft} disabled={saving} onkeydown={editorKey} use:focusEditor></textarea></label>
        <div class="editor-actions"><button class="save" disabled={saving}>{saving ? 'Enregistrement…' : 'Enregistrer'}</button><button type="button" onclick={cancelEdit} disabled={saving}>Annuler</button></div>
      </form>
    {:else}
      <button bind:this={captionButton} class="inline-caption editable" class:empty={!photo.caption_fr} type="button" onclick={() => startEdit('caption')} title="Modifier la légende">{photo.caption_fr || 'Ajouter une légende…'}</button>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="card-footer"><span class="feedback" role="status">{feedback}</span><form method="POST" action="?/deletePhoto&view=photos" use:enhance={remove}><input name="id" type="hidden" value={photo.id} /><button class="delete" disabled={saving || deleting} type="submit">{deleting ? 'Suppression…' : 'Supprimer'}</button></form></div>
  </div>
</article>

<style>
  .library-card{min-width:0;border:1px solid #d7cbbc;background:#faf6ef;overflow:hidden;border-radius:2px}.library-card.selected{border-color:#987249;box-shadow:0 0 0 1px #987249}.image-area{position:relative;min-width:0}.library-select{position:absolute;top:10px;left:10px;z-index:1;background:#fffaf1eb;padding:8px;display:flex;border-radius:3px;cursor:pointer}.library-select input{width:18px;height:18px;accent-color:#70553e;margin:0;cursor:pointer}.library-image{display:block;aspect-ratio:4/3;background:#d0c0ab;padding:0;border:0;width:100%;cursor:zoom-in}.library-image img{display:block;width:100%;height:100%;object-fit:cover}.edit-photo{position:absolute;top:10px;right:10px;display:grid;place-items:center;width:34px;height:34px;background:#fffaf1ed;color:#674a32;border:1px solid #ddcdb8;border-radius:3px}.edit-photo:hover{background:#fffaf1;color:#38291c}.library-meta{padding:15px;display:grid;align-content:start;gap:10px;overflow-wrap:anywhere}.editable{border:0;background:transparent;text-align:left;justify-self:start;max-width:100%;padding:3px 0;cursor:text;border-bottom:1px dashed transparent;white-space:pre-wrap;overflow-wrap:anywhere}.editable:hover{border-bottom-color:#bd9c79}.inline-date{font-size:11px;color:#8d745b}.inline-caption{font-size:13px;font-weight:500;color:#443326;line-height:1.5}.inline-caption.empty{color:#9b8671;font-style:italic}label{display:block;font-size:11px;color:#6c5440;font-weight:600}input[type='date'],textarea{display:block;width:100%;min-width:0;margin-top:6px;padding:9px;background:#fffdf9;border:1px solid #c7b398;color:#382f25;font-size:12px;border-radius:2px}textarea{resize:vertical;min-height:80px}.editor-actions{display:flex;align-items:center;gap:10px;margin-top:9px;flex-wrap:wrap}.editor-actions button{background:none;border:0;color:#80674f;padding:7px 8px;font-size:10px}.editor-actions .save{background:#6c513b;color:#fff7e9}.card-footer{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-top:3px}.feedback{color:#527347;font-size:10px}.delete{border:0;background:transparent;color:#995d4c;padding:6px 0;font-size:10px;text-decoration:underline}.error{color:#923a2d;font-size:11px;margin:0;line-height:1.5}button:disabled{opacity:.6;cursor:wait}.library-card.list{display:grid;grid-template-columns:160px minmax(0,1fr)}.list .library-image{height:100%;min-height:165px;aspect-ratio:auto}.list .library-meta{align-content:center}
  @media(max-width:700px){.library-meta{padding:12px}.library-card.list{grid-template-columns:120px minmax(0,1fr)}.library-select{top:7px;left:7px;padding:6px}.edit-photo{top:7px;right:7px;width:30px;height:30px}.inline-date{font-size:10px}}
</style>
