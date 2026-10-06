import { defineConfig } from 'vite';

export default defineConfig({
  base: '/portfolio-terminal/',
  appType: 'spa',
  build: {
    target: 'es2022'
  }
});
