// @ts-check
// Docusaurus configuration for the react-x11 documentation site.
// See https://docusaurus.io/docs/api/docusaurus-config

const { themes: prismThemes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'react-x11',
  tagline:
    'A React renderer whose host environment is an X11 server — no DOM, no HTML, no native bridge',
  favicon: 'img/favicon.svg',

  url: 'https://sidorares.github.io',
  baseUrl: '/react-x11/',
  trailingSlash: false,

  organizationName: 'sidorares',
  projectName: 'react-x11',

  onBrokenLinks: 'throw',
  // The narrative pages link deep into the synced reference; a heading
  // renamed in docs/ must break the build, not just the link.
  onBrokenAnchors: 'throw',

  markdown: {
    // Reference pages are synced verbatim from the repo's docs/ directory and
    // are plain Markdown (they contain <element> names and {braces} that are
    // not valid MDX). 'detect' parses .md as CommonMark and .mdx as MDX.
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          editUrl:
            'https://github.com/sidorares/react-x11/tree/master/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/favicon.svg',
      colorMode: {
        defaultMode: 'light',
        disableSwitch: false,
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'react-x11',
        logo: {
          alt: 'react-x11 logo',
          src: 'img/favicon.svg',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docs',
            position: 'left',
            label: 'Docs',
          },
          { to: '/playground', label: 'Playground', position: 'left' },
          {
            href: 'https://github.com/sidorares/react-x11',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Introduction', to: '/docs/intro' },
              { label: 'Elements', to: '/docs/reference/elements' },
              { label: 'Components', to: '/docs/reference/components' },
              { label: 'Playground', to: '/playground' },
            ],
          },
          {
            title: 'Project',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/sidorares/react-x11',
              },
              {
                label: 'npm',
                href: 'https://www.npmjs.com/package/react-x11',
              },
              {
                label: 'Issues',
                href: 'https://github.com/sidorares/react-x11/issues',
              },
            ],
          },
          {
            title: 'The stack below',
            items: [
              { label: 'ntk', href: 'https://sidorares.github.io/ntk/' },
              {
                label: 'node-x11',
                href: 'https://sidorares.github.io/node-x11/',
              },
              { label: 'X.Org', href: 'https://www.x.org/wiki/Documentation/' },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} react-x11 contributors. Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'json', 'jsx', 'tsx'],
      },
    }),
};

module.exports = config;
