# Installation

The CLI is published to npm as [`medialocker`](https://www.npmjs.com/package/medialocker)
and runs on **Node.js ≥ 22**.

## Install globally

```bash
npm install -g medialocker
```

This puts a `medialocker` binary on your `PATH`. With pnpm or yarn:

```bash
pnpm add -g medialocker
yarn global add medialocker
```

## Run without installing

```bash
npx medialocker --help
```

`npx` downloads and runs the latest version on demand — handy for CI or one-off
commands.

## Verify

```bash
medialocker --version
medialocker --help
```

`--help` prints the banner and the full list of command groups. Every group also
has its own help, e.g. `medialocker media --help`.

## Upgrade

```bash
npm install -g medialocker@latest
```

Release notes and tagged versions are on
[GitHub](https://github.com/medialocker/medialocker-cli/releases).

## Next steps

- [Configuration & Auth](/developer/cli/configuration) — connect the CLI to your organization
- [Command Reference](/developer/cli/commands) — what every command does
