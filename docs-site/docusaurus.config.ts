import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'STELLA',
  tagline: 'System for Testing and Engineering LLM-based Conversational Agents',
  favicon: 'img/favicon.ico',

  clientModules: [
    require.resolve('./src/clientModules/scrollDetector.js'),
  ],

  // GitHub Pages configuration
  url: 'https://c4dhi.github.io',
  baseUrl: '/STELLA/',
  organizationName: 'c4dhi',
  projectName: 'STELLA',
  deploymentBranch: 'gh-pages',
  trailingSlash: false,

  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },


  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: 'docs', // Serve docs at /docs/
          editUrl: 'https://github.com/c4dhi/STELLA/tree/main/docs-site/',
          // Versioning configuration
          // When you release a version, run: npm run docusaurus docs:version X.Y.Z
          // Then update this config to set lastVersion and add banner: 'unreleased' to current
          lastVersion: 'current',
          versions: {
            current: {
              label: '2.0.0',
              path: '',
              // banner: 'unreleased', // Enable this after creating first versioned release
            },
          },
        },
        blog: false, // Disable blog
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/stella-social-card.png',
    colorMode: {
      defaultMode: 'dark',
      // Toggle is shown on docs pages; hidden on the landing page via CSS
      // (see the ".landing-page-content ... colorModeToggle" rule in custom.css).
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'STELLA',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/docs/changelog',
          label: 'Changelog',
          position: 'left',
        },
        {
          type: 'html',
          position: 'right',
          value: '<a href="https://github.com/c4dhi/STELLA" target="_blank" rel="noopener noreferrer" class="navbar-github-btn"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg><span>GitHub</span></a>',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Getting Started',
              to: '/docs/guides/getting-started',
            },
            {
              label: 'Architecture',
              to: '/docs/architecture/overview',
            },
            {
              label: 'SDK Reference',
              to: '/docs/sdk/overview',
            },
          ],
        },
        {
          title: 'Deployment',
          items: [
            {
              label: 'Kubernetes',
              to: '/docs/deployment/kubernetes',
            },
            {
              label: 'Production Checklist',
              to: '/docs/deployment/production-checklist',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'Contributing',
              to: '/docs/contributing',
            },
            {
              label: 'Changelog',
              to: '/docs/changelog',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/c4dhi/STELLA',
            },
            {
              label: 'C4DHI',
              href: 'https://www.c4dhi.org/',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} STELLA Project. A project by the <a href="https://www.c4dhi.org/" target="_blank" rel="noopener noreferrer">Center for Digital Health Interventions</a>.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'yaml', 'json', 'typescript', 'python'],
    },
    tableOfContents: {
      minHeadingLevel: 2,
      maxHeadingLevel: 4,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
