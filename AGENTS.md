# Agent guidance

## Project purpose

RN Laravel API Runner is a local desktop dashboard for running an existing React Native Expo project with an existing Laravel API. Keep labels, defaults, examples, and documentation useful for projects beyond any one company or repository.

## Local configuration and privacy

- Never add real API keys, passwords, tokens, LAN addresses, personal directories, or project-specific domains to source, fixtures, screenshots, or docs.
- Keep machine settings in the user config directory, outside this repository. `runner.config.example.json` must contain only generic defaults.
- Do not inspect or alter developers' saved local config unless task explicitly requires it.
- Keep personal app/backend `.env` files untouched. Runner may override Expo child-process environment values only for the process it starts.

## Process safety

- Stop only child processes owned by Runner. Never kill by port, executable name, or broad process match.
- Do not adopt an existing unrelated process as a managed service.
- Preserve loopback-only dashboard binding and same-origin/session protections.

## Development

- Keep the app dependency-light and compatible with supported Windows and macOS workflows.
- Use readable ES modules and keep UI copy aligned with `README.md` and About dialog.
- Run `npm test` for behavior changes and `npm run check` when validating setup logic.
- Do not publish, push, or create pull requests unless user explicitly requests it.
