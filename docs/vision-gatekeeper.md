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
- Backend and router Wrangler dry-run bundles; frontend built with `VITE_CF_ACCESS_MODE=true` for the installed Access deployment.
- Transport tests exercise the real provider serializer for Astra, Terra and Sol, plus malformed images, limits and the default OCR prompt. They are not a substitute for a live OCR test through the workspace binding.

## Deployment and rollback

The custom build targets the existing `cloudflare-os-workshop` backend and `cloudflare-os` router. Version uploads copy the **actively deployed version's** bindings and runtime settings, retain secrets and observability, and verify bindings and the existing `v3` migration tag before promotion. No migrations or data deletion are needed.

The original active versions are:

- Backend: `e2b02f97-0903-4693-91e0-6bd9cae8afa2`
- Router: `2df9170d-b416-4f78-a894-ec97c6f971dd`

Cloudflare's latest uploaded script can differ from the active version after a pause/resume. Always resolve the version from the latest deployment; do not use the latest upload as the baseline.

Build artifacts, private binding snapshots and the staged deployment/rollback script are stored locally in `/tmp/cfos-vision-deploy`, outside Git. The script accepts `stage`, `promote` and `rollback`, reads the existing Wrangler session in memory, and checks active version IDs before mutations. Never commit credential files or private snapshots.

Appflare's installation currently originates from the official catalog, not this source checkout. Per-app automatic updates are disabled with the owner's approval so a catalog update cannot overwrite the patch. The catalog UI can still show the official version; the custom version IDs in Cloudflare identify the actual deployment. Changing settings or manually updating from the official catalog may replace the custom build. Integrate future upstream changes into this branch, resolve conflicts, rerun verification and build before deploying again. A Git fork alone does not change Appflare's installation source or provide automatic deployment.
