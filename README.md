# @webbers/cloudflare-r2-medusa

A Medusa v2 file provider plugin that integrates Cloudflare R2 for file storage. Supports a dual-bucket setup with a public CDN bucket and a private bucket, with presigned URLs for secure private file access.

## Features

- Upload files to a public R2 bucket (served via CDN) or a private R2 bucket
- Presigned download URLs for private files; direct CDN URLs for public files
- Presigned upload URLs for client-side uploads
- Streaming upload and download support
- Bulk delete with per-bucket routing

## Requirements

- Medusa v2.8.0 or later
- Node.js 20 or later

## Installation

```bash
npm install @webbers/cloudflare-r2-medusa
# or
pnpm add @webbers/cloudflare-r2-medusa
```

## Configuration

Add the provider to your `medusa-config.ts`:

```ts
import { defineConfig } from '@medusajs/framework/utils'

export default defineConfig({
  modules: [
    {
      resolve: '@medusajs/medusa/file',
      options: {
        providers: [
          {
            resolve: '@webbers/cloudflare-r2-medusa/modules/cloudflare-r2',
            id: 'r2',
            options: {
              file_url: process.env.R2_FILE_URL,
              access_key_id: process.env.R2_ACCESS_KEY_ID,
              secret_access_key: process.env.R2_SECRET_ACCESS_KEY,
              region: 'auto',
              bucket: process.env.R2_BUCKET,
              endpoint: process.env.R2_ENDPOINT,
              prefix: process.env.R2_PREFIX,
              private_bucket: process.env.R2_PRIVATE_BUCKET,
              private_file_url: process.env.R2_PRIVATE_FILE_URL,
            },
          },
        ],
      },
    },
  ],
})
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `R2_FILE_URL` | Yes | Base URL for the public bucket (e.g. your CDN URL: `https://assets.example.com`) |
| `R2_ACCESS_KEY_ID` | Yes | R2 API token access key ID |
| `R2_SECRET_ACCESS_KEY` | Yes | R2 API token secret access key |
| `R2_BUCKET` | Yes | Public bucket name |
| `R2_ENDPOINT` | Yes | R2 S3-compatible endpoint: `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_PREFIX` | No | Key prefix applied to all uploaded files (e.g. `uploads`; a trailing slash is added automatically) |
| `R2_PRIVATE_BUCKET` | No | Private bucket name. Required when uploading files with `access: 'private'` |
| `R2_PRIVATE_FILE_URL` | No | Base URL for the private bucket. Falls back to `R2_FILE_URL` if not set |

### All options

| Option | Type | Default | Description |
|---|---|---|---|
| `file_url` | `string` | — | Base URL for public file URLs |
| `access_key_id` | `string` | — | R2 access key ID |
| `secret_access_key` | `string` | — | R2 secret access key |
| `region` | `string` | — | Use `'auto'` for R2 |
| `bucket` | `string` | — | Public bucket name |
| `endpoint` | `string` | — | R2 S3-compatible endpoint URL |
| `prefix` | `string` | `''` | Object key prefix applied to all uploads; a trailing slash is added automatically |
| `private_bucket` | `string` | — | Private bucket name |
| `private_file_url` | `string` | `file_url` | Base URL for private bucket file URLs |
| `cache_control` | `string` | — | `Cache-Control` header set on uploaded objects |
| `download_file_duration` | `number` | `3600` | Presigned URL expiry in seconds |

## Dual-bucket setup

Files uploaded with `access: 'public'` go to `bucket`. Files uploaded with `access: 'private'` go to `private_bucket`.

The provider encodes the target bucket into the Medusa file key (`pub|<s3key>` or `prv|<s3key>`), so all subsequent operations — delete, stream, buffer read — are automatically routed to the correct bucket.

`getPresignedDownloadUrl` returns:
- **Public files** — the direct CDN URL (`file_url/<key>`)
- **Private files** — a temporary presigned URL valid for `download_file_duration` seconds

## Cloudflare R2 setup

1. Create two R2 buckets in the Cloudflare dashboard: one public (with a custom domain or `r2.dev` subdomain enabled) and one private.
2. Create an API token under **R2 > Manage R2 API tokens** with **Object Read & Write** permissions scoped to both buckets.
3. Copy the **Access Key ID** and **Secret Access Key** into your environment.
4. Find your S3-compatible endpoint on the same page: `https://<account-id>.r2.cloudflarestorage.com`.
5. Set `R2_FILE_URL` to your CDN or public bucket URL (e.g. `https://assets.example.com`).

## License

MIT
