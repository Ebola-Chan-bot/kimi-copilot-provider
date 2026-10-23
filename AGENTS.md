# Project Guidelines

## Package Manager

- Use pnpm for all Node.js dependency management and package-script execution in this repository.
- The canonical package manager is `pnpm@10.28.0`, as declared in `package.json`. Keep `pnpm-lock.yaml` as the only dependency lockfile.
- Install dependencies with `pnpm install`. Run package scripts with `pnpm run <script>` and local binaries with `pnpm exec <command>`. Use `pnpm dlx` for one-off executables when appropriate.
- Do not use npm or yarn, including `npm install`, `npm install --no-save`, `npx`, or yarn equivalents. Do not create `package-lock.json` or `yarn.lock`.
- Do not modify `package.json` or `pnpm-lock.yaml` merely to install temporary tooling. Use an isolated pnpm-based setup and leave dependency manifests unchanged unless the task requires dependency changes.
- If existing documentation shows an npm command, use an appropriate pnpm equivalent instead of running npm.
