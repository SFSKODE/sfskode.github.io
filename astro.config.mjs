import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { satteri } from '@astrojs/markdown-satteri';
import { handleSalesforceApi } from './scripts/sf-api.mjs';
import { enhanceMarkdown, codeBlockTransformer } from './src/plugins/enhance-markdown.mjs';

// Change SITE_URL when you buy your domain (or set it as an environment variable).
const site = process.env.SITE_URL || 'https://example.com';

// Pages that should not appear in the sitemap (exact paths, not substring matches).
const HIDDEN = new Set(['/maintenance/', '/404/', '/search/']);

// Mounts the Salesforce playground API in `astro dev` and `astro preview` (production uses scripts/server.mjs).
const salesforceApi = {
  name: 'sf-playground-api',
  configureServer(server) { server.middlewares.use((req, res, next) => { if (!handleSalesforceApi(req, res)) next(); }); },
  configurePreviewServer(server) { server.middlewares.use((req, res, next) => { if (!handleSalesforceApi(req, res)) next(); }); },
};

export default defineConfig({
  vite: { plugins: [salesforceApi] },
  site,
  output: 'static',
  integrations: [
    sitemap({
      filter: (page) => !HIDDEN.has(new URL(page).pathname),
    }),
  ],
  markdown: {
    processor: satteri({ hastPlugins: [enhanceMarkdown] }),
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      wrap: false,
      transformers: [codeBlockTransformer],
    },
  },
  build: { format: 'directory' },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
});
