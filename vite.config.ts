import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';

export default defineConfig({
  plugins: [sveltekit({ adapter: adapter() })],
  // Keep the journal at its documented address; a second preview must use an explicit port.
  server: { strictPort: true }
});
