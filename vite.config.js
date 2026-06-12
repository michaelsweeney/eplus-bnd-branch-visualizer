import { defineConfig } from 'vite';

// SKIP_PUBLIC_COPY=1 keeps the ~330 MB of full-resolution demo data in
// public/demo-data/ out of dist — the demo-site build replaces it with
// decimated versions (scripts/build-demo-site.mjs).
export default defineConfig({
  build: { copyPublicDir: !process.env.SKIP_PUBLIC_COPY }
});
