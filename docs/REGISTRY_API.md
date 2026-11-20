# Registry API

Any HTTP service that implements this contract can back SkillStore.

Base URL examples:

- `http://127.0.0.1:3030`
- `https://skills.example.com`

## Conventions

- **Canonical slug** — `namespace--slug` for non-global namespaces, `slug` for
  `global`. `@team/pdf` and `team/pdf` both resolve to `team--pdf`.
- **Versions** — semantic versions (`1.2.3`, `1.2.3-beta.1`). `latest` means the
  highest published version.
- **Content type** — JSON for metadata, `application/zip` for downloads.
- **Authentication** — optional. The reference server accepts
  `Authorization: Bearer <token>` when started with `--token`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Browser UI (reference server) |
| `GET` | `/healthz` | Liveness probe |
| `GET` | `/api/v1/search?q=&limit=&category=` | Search skills |
| `GET` | `/api/v1/categories` | Category names and counts |
| `GET` | `/api/v1/skills/{canonicalSlug}` | Skill detail |
| `GET` | `/api/v1/skills/{namespace}/{slug}/versions` | Version list, newest first |
| `GET` | `/api/v1/resolve?slug=&version=` | Resolve a version and download URL |
| `GET` | `/api/v1/skills/{namespace}/{slug}/versions/{version}/download` | Download a specific version |
| `GET` | `/api/v1/download/{canonicalSlug}?version=` | Download (short form) |
| `GET` | `/api/v1/whoami` | Identity (local server returns a static identity) |
| `POST` | `/api/v1/publish` | Publish or update a skill (multipart) |

### Search

```http
GET /api/v1/search?q=pdf&limit=20&category=docs
```

```json
{
  "results": [
    {
      "slug": "pdf-toolkit",
      "name": "pdf-toolkit",
      "description": "Extract, split, and merge PDF files.",
      "version": "1.2.0",
      "categories": ["docs"],
      "author": { "handle": "alice", "displayName": "Alice" },
      "downloadCount": 42,
      "starCount": 7,
      "updatedAt": "2026-01-15T10:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

### Resolve

```http
GET /api/v1/resolve?slug=pdf-toolkit&version=1.2.0
```

```json
{
  "slug": "pdf-toolkit",
  "version": "1.2.0",
  "downloadUrl": "/api/v1/skills/global/pdf-toolkit/versions/1.2.0/download"
}
```

`downloadUrl` may be absolute, an absolute path, or a path relative to the
registry root. The client handles all three.

### Publish

`POST /api/v1/publish` with `multipart/form-data`:

| Field | Required | Description |
|-------|----------|-------------|
| `skill` | yes | Zip file containing `SKILL.md` |
| `namespace` | no | Defaults to `global` |
| `version` | no | Omit to auto-increment the patch version |
| `categories` | no | Comma-separated categories |
| `force` | no | `true` to overwrite an existing version |

Success:

```json
{
  "ok": true,
  "isUpdate": false,
  "slug": "pdf-toolkit",
  "namespace": "global",
  "version": "1.0.0",
  "downloadUrl": "/api/v1/download/pdf-toolkit?version=1.0.0"
}
```

Errors use a non-2xx status and `{ "error": "..." }`. Successful publish
responses also include `"ok": true`.

## Reference server

```bash
node local-registry/server.js \
  --port 3030 \
  --host 127.0.0.1 \
  --dir .skillstore-registry \
  --token "$SKILLSTORE_TOKEN" \
  --allow-downgrade
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3030` | Listen port |
| `--host` | `127.0.0.1` | Listen host |
| `--dir` | `local-registry/` | Data directory (`index.json` + `packages/`) |
| `--token` | empty | Require `Authorization: Bearer <token>` for writes |
| `--allow-downgrade` | off | Allow publishing a lower version |

Data layout:

```text
.skillstore-registry/
├── index.json
└── packages/
    └── global/
        └── pdf-toolkit/
            └── 1.0.0.zip
```

## Compatibility notes

- The extension falls back to `/api/cli/v1/skills/search` when
  `/api/v1/search` is missing (404) or failing (5xx).
- Optional endpoints (`categories`, `versions`, `detail`) are skipped gracefully
  when unavailable.
- A registry only needs `search`, `resolve`, `download`, and `publish` for the
  full install/publish flow.
