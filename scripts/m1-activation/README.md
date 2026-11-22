# M1 — real DSH activation of `@huaqiu/hardware-engineering`

This directory is the reproducible activation fixture for M1 §7 of
`dsh-pcb-eda/docs/tasks/m1-impl-spec-huaqiu-hardware-bundle-set.md`.

It boots a **real** DSH CLI profile — `runProfile` from `apps/cli/src/profile-boot.ts`,
with the real `boot` and real plugin `apply()` functions — against a throwaway
installation built from the packed tarballs. Mocked plugin tests are not accepted
as activation evidence by the spec, so nothing here is mocked except
`process.exit` during teardown (see below).

## Run

From the `deepseek-harness` workspace root, after `pnpm install` and after
`pnpm -r pack --pack-destination dist` in the sibling `dsh-pcb-eda` workspace:

```sh
# Positive: the shipped desktop composition
npx tsx scripts/m1-activation/run.ts --family desktop \
  --dist ../dsh-pcb-eda/dist --version 0.7.10 \
  --out scripts/m1-activation/out

# Negative control: delete a required provider and require the run to fail
npx tsx scripts/m1-activation/run.ts --family desktop --negative missing-provider \
  --dist ../dsh-pcb-eda/dist --version 0.7.10 \
  --out scripts/m1-activation/out
```

The positive run exits `0` only when every check passes. The negative run is
expected to exit `1` with `huaqiu-auth=failed` and
`huaqiu-tool-symbol-footprint=pending missing huaqiuAuth`. Each run writes
`activation-<variant>.json` and `activation-<variant>.log` into `--out`.

## What the fixture proves

- **`fixture.ts`** builds `<tmp>/installation/apps/cli/package.json` (the anchor
  `resolveBundleDir` starts from), extracts the *packed* product bundle and the
  full `@huaqiu/*` dependency closure into a flat `node_modules`, and links
  published third-party dependencies from the product workspace. A declared
  dependency with no artifact is a hard build error, not a silent skip.
- **`network-guard.ts`** blocks every non-loopback TCP connect for the duration
  of the boot. `net.connect`, `tls.connect`, `http`, and `fetch` all funnel
  through the patched method. Any registry access would abort activation.
- **`run.ts`** writes a clean DSH profile selecting
  `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@huaqiu/hardware-engineering']`
  into an isolated `DSH_HOME`, boots it, captures stderr, and records:
  - the resolved bundle directory and version, proving installation-anchor resolution;
  - every Loader row with its raw and scoped id, fiber state, missing services,
    resolved package directory and version;
  - the registered tool schemas and skills;
  - the provider services and `sandboxPolicy.defaultMode`;
  - every outbound connection attempt, including ones that were blocked.
- The checks compare row ids from the *composed patch* against row state from
  the *live Loader*, so a row that was silently skipped cannot pass.

## Teardown caveat (recorded, not hidden)

`createProcessShutdown` may not settle because a mounted surface keeps the tree
alive; after one second the fixture stops waiting and records the outstanding
teardown in `evidence.teardown`. `process.exit` is patched during that bounded
window so a forced exit cannot destroy the evidence before it is written. The
fixture is a one-shot process, so it exits explicitly afterwards. Teardown
health is deliberately **not** one of the activation gates.

## Files

| File | Purpose |
| --- | --- |
| `fixture.ts` | Builds and disposes the installation/profile fixture. |
| `network-guard.ts` | Blocks and records outbound TCP. |
| `run.ts` | Boots the profile and writes JSON + log evidence. |
| `out/` | Evidence from the executed runs cited by the M1 report. |
