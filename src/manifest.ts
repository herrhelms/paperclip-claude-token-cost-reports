import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "claude-token-usage",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Claude Token Usage",
  description:
    "Track Claude token usage per company, accumulate daily totals, and export a weekly CSV priced at configurable per-model rates.",
  author: "Hlmsvrs",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "api.routes.register",
    "ui.page.register",
    "plugin.state.write",
    "jobs.schedule",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui",
  },
  database: {
    migrationsDir: "migrations",
  },
  jobs: [
    {
      jobKey: "rollup-daily",
      displayName: "Roll up daily token usage",
      description:
        "Recompute today's usage_daily rows for each company from usage_events.",
      schedule: "*/15 * * * *",
    },
  ],
  apiRoutes: [
    {
      routeKey: "export-weekly-csv",
      method: "GET",
      path: "/export/weekly.csv",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "usage-page",
        displayName: "Token Usage",
        exportName: "UsagePage",
        routePath: "usage",
      },
      {
        type: "settingsPage",
        id: "usage-settings",
        displayName: "Token Usage Settings",
        exportName: "SettingsPage",
      },
    ],
  },
};

export default manifest;
