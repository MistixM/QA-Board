// Copy to config.local.js and enter your own Notion integration settings.
// config.local.js is ignored by Git. Never commit credentials.
globalThis.MDEV_CONFIG = {
  notionApiKey: '',
  notionDatabaseId: '' // Optional fallback; otherwise select an accessible database.
};
