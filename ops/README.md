# Windows services — the PMS comes back on its own after a power cut

Two services, modelled on the **HotelAPI** service already on this machine (`node-windows`,
which wraps WinSW — same wrapper, same `daemon\` log folders, same Automatic start):

| Service | Runs | Port |
|---|---|---|
| **LegphelPMS Backend** | `back_end/scripts/service-run.mjs` → the API + workers | 4000 |
| **LegphelPMS Desk** | `new_front_end/scripts/service-run.mjs` → the production build | 3002 |

Both declare a dependency on **`postgresql-x64-16`** (the instance on port 5432 that
`back_end/.env` points at).

## Install — once, from an **Administrator** PowerShell

Registering a service needs elevation; there is no way around it. Stop any dev server first,
or the services will fail to bind their ports.

```powershell
cd "C:\Users\DELL\Desktop\Backend_Revamp\ops"
npm install            # once
node install-services.cjs
```

Installing also starts both. Re-running is safe — an existing service is left alone.

## Day to day

```powershell
node status.cjs                      # state, ports, last error — no elevation needed

Restart-Service "LegphelPMS Backend" # after a git pull
Restart-Service "LegphelPMS Desk"    # after `npm run build` in new_front_end
Stop-Service    "LegphelPMS Desk"    # to hand a port back to a dev server
```

**After a `git pull`:** the backend picks up the new code on restart by itself (it runs the
TypeScript source, not a build). The desk does **not** — it serves a compiled build, so:

```powershell
cd "C:\Users\DELL\Desktop\Backend_Revamp\new_front_end"
npm run build
Restart-Service "LegphelPMS Desk"
```

If a migration came with the pull, apply it and regenerate the client **before** restarting the
backend, and stop the service first — a running service holds the Prisma engine DLL and
`prisma generate` fails with EPERM:

```powershell
Stop-Service "LegphelPMS Backend"
cd "C:\Users\DELL\Desktop\Backend_Revamp\back_end"
npx prisma migrate deploy; npx prisma generate
Start-Service "LegphelPMS Backend"
```

## Logs

`node-windows` writes them beside each runner, in its own `daemon\` folder (gitignored):

```
back_end\scripts\daemon\legphelpmsbackend.err.log      ← start here when something is wrong
back_end\scripts\daemon\legphelpmsbackend.out.log
back_end\scripts\daemon\legphelpmsbackend.wrapper.log  ← restarts, as the wrapper saw them
new_front_end\scripts\daemon\legphelpmsdesk.*.log
```

## Why there is a database wait

ProductionAPI — the sibling of HotelAPI in `C:\Users\DELL\Documents\intern` — was left
**Stopped, exit code 1067** by the outage on 21 Sept 2026, and HotelAPI's own error log from the
same minute reads `the database system is starting up`.

That is the failure this is built around. When the power returns every Automatic service starts
at once, and Postgres **accepts connections several seconds before it will answer a query**. A
server that opens its pool in that window throws; the wrapper retries; the default budget of
three restarts is spent inside the same window; the service stays down until somebody notices.

So two things guard it, because neither is enough alone:

- **The service dependency** gets the ordering roughly right — but Windows calls Postgres
  "started" when the service reports running, which is before crash recovery finishes.
- **`service-run.mjs` waits for a real `SELECT 1`**, retrying for up to five minutes, before it
  starts the server at all.

`maxRestarts` is also raised to 40 (the default is 3). With the readiness wait in front, a
restart now means something is genuinely wrong — and on a machine nobody is watching, retrying
for longer is the friendlier failure.

## Uninstall

```powershell
node uninstall-services.cjs          # Administrator
```

Log folders are left on disk on purpose — the reason a service was removed is usually in them.

## Changing a definition

Edit `services.cjs` (names, ports, dependency, restart policy), then uninstall and reinstall —
`node-windows` does not rewrite an existing registration.

To serve a compiled backend instead of the source, change `RUNNER` in
`back_end/scripts/service-run.mjs` to `node dist/index.js` and add `npm run build` to the pull
routine. Faster to start and more conventional; the cost is that a pull without a build silently
keeps serving the old code.
