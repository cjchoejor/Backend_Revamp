# Backend (S5–S9 slice)

## Running S6 acceptance tests (deterministic)

From `back_end/`:

```bash
npm run test:s6
```

This always runs `db:seed` first, then executes `scripts/s6-acceptance-tests.ts`.

