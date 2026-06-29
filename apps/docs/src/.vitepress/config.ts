import { defineConfig } from "vitepress";

export default defineConfig({
  title: "MediaLocker Docs",
  description: "Documentation for MediaLocker — media storage for creators",
  lang: "en-US",
  base: "/",
  cleanUrls: true,
  lastUpdated: true,
  appearance: "force-dark",

  sitemap: {
    hostname: "https://docs.medialocker.io",
  },

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#6d5ef6" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "MediaLocker Docs" }],
    [
      "meta",
      {
        property: "og:description",
        content: "Documentation for MediaLocker — media storage for creators",
      },
    ],
    ["meta", { name: "twitter:card", content: "summary" }],
  ],

  themeConfig: {
    logo: { light: "/logo.svg", dark: "/logo.svg", alt: "MediaLocker" },

    nav: [
      { text: "User Guide", link: "/user/" },
      { text: "Developer Docs", link: "/developer/" },
      { text: "CLI", link: "/developer/cli/" },
      { text: "Operations Guide", link: "/self-hosting/" },
      { text: "medialocker.io", link: "https://medialocker.io" },
    ],

    sidebar: {
      "/user/": [
        {
          text: "User Guide",
          items: [
            { text: "Overview", link: "/user/" },
            { text: "Getting Started", link: "/user/#getting-started" },
          ],
        },
        {
          text: "Storage",
          items: [
            { text: "Buckets", link: "/user/buckets" },
            { text: "Uploading Files", link: "/user/upload" },
            { text: "Media Library", link: "/user/media-library" },
          ],
        },
        {
          text: "Organization",
          items: [
            { text: "Tags & Categories", link: "/user/organization" },
            { text: "Sets", link: "/user/sets" },
            { text: "Storyboards", link: "/user/storyboards" },
          ],
        },
        {
          text: "Account",
          items: [
            { text: "API Keys", link: "/user/api-keys" },
            { text: "Usage & Billing", link: "/user/usage-billing" },
          ],
        },
      ],
      "/developer/": [
        {
          text: "Developer Docs",
          items: [
            { text: "Overview", link: "/developer/" },
            { text: "Authentication", link: "/developer/authentication" },
            { text: "Rate Limits", link: "/developer/rate-limits" },
            { text: "Errors", link: "/developer/errors" },
            { text: "Idempotency", link: "/developer/idempotency" },
            { text: "Presigned Uploads", link: "/developer/presign" },
            { text: "API Reference", link: "/developer/api-reference" },
            { text: "Integrations", link: "/developer/integrations" },
            { text: "llms.txt", link: "/developer/llms-txt" },
          ],
        },
        {
          text: "Command Line (CLI)",
          items: [
            { text: "Overview", link: "/developer/cli/" },
            { text: "Installation", link: "/developer/cli/installation" },
            {
              text: "Configuration & Auth",
              link: "/developer/cli/configuration",
            },
            { text: "Command Reference", link: "/developer/cli/commands" },
            { text: "Uploading & Downloading", link: "/developer/cli/uploads" },
            { text: "MCP Server", link: "/developer/cli/mcp" },
          ],
        },
        {
          text: "MCP Server",
          items: [
            { text: "Overview", link: "/developer/mcp/" },
            { text: "Connecting", link: "/developer/mcp/connecting" },
            { text: "Authentication", link: "/developer/mcp/authentication" },
            { text: "Tools", link: "/developer/mcp/tools" },
            { text: "Resources", link: "/developer/mcp/resources" },
            { text: "Rate Limits", link: "/developer/mcp/rate-limits" },
          ],
        },
      ],
      "/self-hosting/": [
        {
          text: "Operations Guide",
          items: [
            { text: "Overview", link: "/self-hosting/" },
            { text: "Requirements", link: "/self-hosting/requirements" },
            { text: "Docker Compose", link: "/self-hosting/docker-compose" },
            {
              text: "Environment Variables",
              link: "/self-hosting/environment",
            },
            { text: "Storage", link: "/self-hosting/storage" },
            { text: "Wildcard TLS", link: "/self-hosting/wildcard-tls" },
            { text: "Backups", link: "/self-hosting/backups" },
            { text: "Scaling", link: "/self-hosting/scaling" },
            { text: "Upgrade Guide", link: "/self-hosting/upgrade" },
          ],
        },
      ],
    },

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/medialocker/medialocker-app",
      },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern:
        "https://github.com/medialocker/medialocker-app/edit/main/apps/docs/src/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the AGPL-3.0 License.",
      copyright: "Copyright © 2026 MediaLocker",
    },
  },

  markdown: {
    theme: {
      light: "dark-plus",
      dark: "dark-plus",
    },
    languageAlias: {
      caddyfile: "nginx",
      env: "ini",
    },
  },
});
