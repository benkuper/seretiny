<script lang="ts">
  let {data, form} = $props();
</script>
<svelte:head><title>Connexion · SereTiny</title></svelte:head>
<div class="login-page">
  <div class="login-card">
    <a href="/" class="back">← Retour au journal</a>
    <div class="eyebrow">L'ATELIER PRIVÉ</div>
    <h1>SereTiny<span>.</span></h1>
    <p>Retrouve ici les journées, les photos et toutes les histoires de la construction.</p>
    {#if !data.ready}<div class="alert">Première configuration : crée le fichier <code>.env</code> à partir de <code>.env.example</code> et renseigne tes secrets.</div>{/if}
    <form method="POST">
      <label for="password">Mot de passe administrateur</label>
      <input id="password" type="password" name="password" autocomplete="current-password" required autofocus />
      {#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
      <button type="submit">Entrer dans l'atelier <span>↗</span></button>
    </form>
  </div>
</div>
<style>
.login-page{min-height:100dvh;display:grid;place-items:center;padding:24px;background:linear-gradient(135deg,rgba(20,16,13,.85),rgba(48,32,23,.9)),url('/workshop.svg') center/cover}
.login-card{width:min(100%,480px);padding:42px;background:#eee7dc;color:#382a20;border:1px solid #fff8ee33;box-shadow:0 30px 90px #0008}
.back{color:#806449;font-size:13px}.eyebrow{margin-top:65px;letter-spacing:.2em;font-size:11px;font-weight:700;color:#96764d}
h1{font-family:'Fraunces',serif;font-size:64px;font-weight:500;letter-spacing:-.07em;margin:10px 0}h1 span{color:#b6864c}
p{line-height:1.75;color:#6f6255;font-size:14px}form{display:grid;gap:12px;margin-top:32px}label{font-weight:600;font-size:12px}
input{border:1px solid #c6b8a7;background:#fffaf4;padding:15px;color:#382a20;border-radius:4px}
button{background:#3d3025;color:#f3e3cf;padding:16px;border:0;display:flex;justify-content:space-between;font-weight:700}
.alert{background:#f3dec7;border:1px solid #d3a579;padding:12px;font-size:12px;line-height:1.6}.error{color:#9d3e30}
</style>
