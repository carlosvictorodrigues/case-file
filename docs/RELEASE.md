# Release Checklist

Run this checklist from the repository root before distributing a `.mcpb`.

```bash
npm ci
npm test
npm run typecheck
npm run release:mcpb   # build + prune --omit=dev + pack + verify + restore
npm audit --omit=dev
```

Expected artifact:

```text
case-file.mcpb
```

Do not distribute if:

- tests fail;
- typecheck fails;
- `verify:mcpb` cannot find a non-empty bundle;
- the manifest asks for any account token or remote URL;
- `npm audit --omit=dev` reports runtime vulnerabilities.
