# Cloudflare AI for MDEV QA Reporter

The extension sends three parallel requests for a title, brief description, and severity. The Worker runs `@cf/openai/gpt-oss-20b` through its `AI` binding using the existing prompts. Each request contains the description text and task.

The deployed endpoint has the form `https://mdev-qa-ai.<your-subdomain>.workers.dev`.

## Deploy

From this directory, run the following commands with Node.js 22 or newer installed.

```sh
npm ci
npx wrangler login
npm run deploy
npx wrangler secret put AI_ENDPOINT_TOKEN
```

Set `account_id` in `wrangler.jsonc` to your own Cloudflare account ID before deploying.

When prompted for `AI_ENDPOINT_TOKEN`, paste the generated token value from the local `.dev.vars` file, excluding the surrounding quotes. This file is ignored by Git. Keep the same value for the extension's endpoint token. For a fresh checkout, generate this file first with the command below; do not commit or share its contents.

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync(".dev.vars", "AI_ENDPOINT_TOKEN=" + randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });'
```

The deployed Worker returns a setup error until its secret is configured. Copy the deployed `https://mdev-qa-ai.<your-subdomain>.workers.dev` URL from Wrangler's output.

`ALLOWED_ORIGIN` in `wrangler.jsonc` is derived from the extension's existing manifest key. If you change that key or use a different extension ID, update this value to `chrome-extension://<extension-id>` and redeploy. You can find the ID at `chrome://extensions` with Developer mode enabled.

The Cloudflare account's Workers Free plan supplies the daily free allocation. On that plan, exhausted quota produces an error until the daily reset at 00:00 UTC. The Worker makes one inference attempt per request. Account billing and plan selection are managed in Cloudflare. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## Configure the extension

1. Reload the unpacked `mdev-src` extension at `chrome://extensions`.
2. Open its popup and enter the deployed Worker URL and the `AI_ENDPOINT_TOKEN` value.
3. Select **Save AI settings** and grant access to your Worker hostname. The URL and token are stored locally on this device, with storage access restricted to trusted extension contexts.
4. Capture a screenshot, enter a description longer than 10 characters, and select **Complete with AI**.

The manifest declares optional access to `https://*.workers.dev/*`. Saving settings requests permission for the entered hostname. URLs accept the Worker root or `/generate` path. Custom-domain endpoints require a corresponding optional host permission and URL validation update.

## API

Send `POST /generate` with `Content-Type: application/json` and `Authorization: Bearer <AI_ENDPOINT_TOKEN>`.

```json
{ "task": "title", "description": "The checkout button does nothing when clicked." }
```

`task` accepts `title`, `brief`, or `severity`. Descriptions must contain more than 10 characters after trimming. A successful response has the following shape.

```json
{ "text": "Checkout button fails to respond" }
```

Errors return `{ "error": "..." }` with an appropriate HTTP status. The Worker accepts CORS requests from its configured extension origin and authenticated requests without an Origin header for CLI verification. Inference responses time out after 55 seconds. The editor aborts its requests after 60 seconds and cancels remaining requests when one fails. Form fields update together after every result and severity have been validated.

## Verify

```sh
npm test
npx wrangler deploy --dry-run
```

Tests run with Node's built-in test runner and mocked inference, extension APIs, network responses, and editor elements. They cover prompts, authentication, CORS, malformed requests and outputs, quota and timeout errors, local settings, parallel generation, severity normalization, and preserving form values on failure.

After deployment, check representative descriptions for cosmetic, visible non-blocking, and blocking bugs. Verify that an incorrect endpoint token displays an authentication error and restores the AI button. Restore the valid token and submit reports to both configured destinations to verify the live workflow.

For local Worker development, `npm run dev` reads `.dev.vars`. The Workers AI binding accesses your Cloudflare account and consumes its inference allocation during development. [Workers AI setup](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/)
