# Vision and OCR Gatekeepers (QuarionGG customization)

This branch extends the installed upstream revision `b4f706a` with image input for model bindings and a dedicated OCR connection. It reuses the owner's existing configured model, authorization and provider transport. It creates no new Worker, Durable Object namespace or third-party OCR service.

```ts
LLM.run({prompt, systemPrompt?, images?}): Promise<string>
OCR.readImages({images, prompt?, systemPrompt?}): Promise<string>
// images: {mimeType: "image/png" | "image/jpeg" | "image/webp", data: string}[]
```

`data` is canonical padded Base64 of the original bytes (no URL or data URL). Limits: five images, 4 MiB per image, 5 MiB total decoded bytes; supported dimensions follow the existing attachment validator. OCR without a prompt defaults to verbatim transcription. Both bindings require a vision-capable model for image requests. Text-only `run` calls remain compatible. Blueprints preserve the OCR purpose.

In the workspace's Add connection dialog, choose an existing language model, then select **Vision / OCR** as its connection type. Existing language-model Gatekeepers advertise the extended `run` type after their binding description is refreshed. The workspace's app code still has to send the image bytes; attaching a file to the agent chat does not automatically add it to a binding invocation.

## Verification

- `COREPACK_HOME=/tmp/cfos-corepack pnpm lint`: 84/84 successful tasks.
- Backend model, invocation and blueprint tests: 321 passed.
- GatekeeperModal frontend tests: 17 passed.
- Binding description tests (including an empty optional gadget selector): 4 passed.
- Backend and router Wrangler dry-run bundles; frontend built with `VITE_CF_ACCESS_MODE=true` for the installed Access deployment.
- Transport tests exercise the real provider serializer for Astra, Terra and Sol, plus malformed images, limits and the default OCR prompt. They are not a substitute for a live OCR test through the workspace binding.

## Deployment and rollback

The custom build targets the existing `cloudflare-os-workshop` backend and `cloudflare-os` router. Version uploads copy the **actively deployed version's** bindings and runtime settings, retain secrets and observability, and verify bindings and the existing `v3` migration tag before promotion. No migrations or data deletion are needed.

The original active versions are:

- Backend: `e2b02f97-0903-4693-91e0-6bd9cae8afa2`
- Router: `2df9170d-b416-4f78-a894-ec97c6f971dd`

Cloudflare's latest uploaded script can differ from the active version after a pause/resume. Always resolve the version from the latest deployment; do not use the latest upload as the baseline.

Build artifacts, private binding snapshots and the staged deployment/rollback script are stored locally in the gitignored `.local-vision-deploy/` directory (with temporary build copies in `/tmp/cfos-vision-deploy`). The script accepts `stage`, `promote` and `rollback`, reads the existing Wrangler session in memory, and checks active version IDs before mutations. Never commit credential files or private snapshots.

Appflare's installation currently originates from the official catalog, not this source checkout. Per-app automatic updates are disabled with the owner's approval so a catalog update cannot overwrite the patch. The catalog UI can still show the official version; the custom version IDs in Cloudflare identify the actual deployment. Changing settings or manually updating from the official catalog may replace the custom build. Integrate future upstream changes into this branch, resolve conflicts, rerun verification and build before deploying again. A Git fork alone does not change Appflare's installation source or provide automatic deployment.

## Fork maintenance

The fork is https://github.com/QuarionGG/cloudflare-os. Its default and deployment-source branch is `vision-gatekeeper`; `upstream` points to `cloudflare/cloudflare-os`. The deployed runtime patch is in commits `3261d93d` (kernel/shared) and `016cfc37` (frontend/docs), based on `b4f706a`. Commit `a82dd86e` adds tested compatibility for model callers that send an empty optional gadget selector during binding inspection.

Update in a review branch rather than force-syncing the production branch:

```sh
git fetch upstream
git switch -c update/upstream-YYYY-MM-DD origin/vision-gatekeeper
git merge upstream/main
# Resolve conflicts; inspect API changes and Durable Object migrations.
pnpm lint
pnpm --filter @gadgets/workshop-backend test:run
pnpm --filter @gadgets/workshop-frontend test:run
# Review before merging into vision-gatekeeper and building/deploying.
```

Upstream merges can require changes even when Git reports no conflicts. Do not force-reset the customized branch to upstream. No Actions workflows, triggers or secrets were changed for this fork; no automatic deployment pipeline is configured. Appflare source-repository installations in this manager version require manual rebuild/review, and the existing catalog installation cannot be switched to a repository through its current UI. The current deployment therefore uses this fork's build on the existing resources, with Appflare catalog auto-updates off. Do not reinstall or manipulate the manager database merely to change its source label.

Custom active versions, verified with all original bindings and the existing migration tag:

- Backend: `85e0f043-3c80-4de0-8de0-d96554b71346`
- Router: `da841272-6dd3-4a16-92a2-dc3c9ef0afc9`

Local rollback, after verifying these are still the active versions:

```sh
node .local-vision-deploy/deploy.mjs rollback
```

Cloudflare has deferred Durable Object code updates by default since 2026-10-30. An active object can run the previous code for up to 300 seconds after promotion; a browser reload alone does not force its server object to update. For an explicitly coordinated immediate activation, Wrangler supports `versions deploy <version>@100% --name cloudflare-os-workshop --durable-objects-code-update-mode immediate`; this restarts active object execution and may reconnect clients, without modifying persisted storage. Confirm no agent turn is in progress before using immediate mode. See [Cloudflare's change notice](https://developers.cloudflare.com/changelog/product/durable-objects/).

## Live verification

On 2026-11-04, the existing OCR test workspace described an `OcrModelBinding`, a `LanguageModelBinding`, and its `Worktree`. It read 43,585 bytes from the existing `clipboard.png` with `readBytes`, encoded the bytes once, and called both `readImages({images})` without an optional prompt and `run({prompt,images})` through the actual configured Terra bindings. Both returned:

```text
VERIFICA LETTURA IMMAGINE

Codice: 3F378DBA03

Città: Forlì — quantità: 7

Totale: 123,45 EUR
```

The tool execution output was inspected, not just the agent's summary. The test did not modify any files or apps. Proof screenshot: `/tmp/cfos-gatekeeper-live-proof.png` on the local operator machine. This verifies the Gatekeeper path in addition to the earlier independent chat-image checks for Astra, Terra and Sol.

The existing Agenda & Conti gadget now retains its original `LLM` connection and has a second persisted `OCR` connection using GPT-6.1 Terra. The connection was accepted and checked after a browser reload. Its own agent re-described both gadget bindings and confirmed `LLM.run(..., images?)` and `OCR.readImages(...)`. No receipt, document, app code or app data was read or modified for that final type check. The app's receipt-intake code still needs to invoke the new interface when the user chooses to integrate it.
