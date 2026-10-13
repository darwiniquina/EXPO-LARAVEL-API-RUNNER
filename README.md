# RN Laravel API Runner

Local dashboard for starting an existing React Native Expo app and Laravel API together. Runner selects a LAN address, starts both services, and shows a verified Expo link and QR code for a phone on the same reachable network.

## Requirements

- Node.js 24 or newer
- PHP available on `PATH`, or a configured PHP executable
- Laravel API project with Composer dependencies installed and a valid local `.env`
- React Native Expo project with dependencies installed and a development build or Expo Go
- Windows or macOS for the included launch scripts

Runner does not install app dependencies, create or edit app `.env` files, start databases or queues, run migrations, clear framework caches, or build a mobile app.

## Start

From this folder:

```sh
npm install
npm start
```

Open `http://127.0.0.1:4310` if Runner does not open a browser. Windows users can also run `scripts/start-windows.cmd`. On macOS, run `chmod +x scripts/start-macos.command` once, then open that script in Terminal. Keep Runner terminal open while using it.

Settings live outside this project in `~/.rn-laravel-api-runner/config.json`. On Windows, `~` means your user profile folder. On first launch, enter paths to your Expo and Laravel projects. Existing Runner users have settings copied to the new folder automatically on first launch; original settings file stays in place.

## Use

1. Set mobile project folder, Laravel API folder, PHP executable, ports, and phone-reachable network adapter.
2. Click **Save Settings**, then **Check Setup**.
3. Click **Start Both**. Runner starts Laravel, waits for its port, then starts Expo and waits for Metro.
4. Scan the verified Expo link with your development build or Expo Go.
5. Use **Stop All Services** when done. **Exit Runner** also closes the dashboard.

Runner passes `EXPO_PUBLIC_API_URL` and `REACT_NATIVE_PACKAGER_HOSTNAME` only to the Expo process it starts. It does not edit the Expo or Laravel `.env` files. The API URL uses the selected LAN address and API port, so stop and restart services after changing networks. The Expo app remains responsible for its own tenant or domain configuration.

Closing the browser leaves Runner and services active. Changing service folders, ports, runtime, or network settings requires stopped services. Dashboard port changes apply after restarting Runner. A duplicate `npm start` opens the active dashboard. If its configured port is busy, Runner tries the next 20 ports.

## Network and recovery

- When several IPv4 adapters exist, select the one your phone can reach. Runner avoids guessing.
- VPN routing, firewalls, guest Wi-Fi, and client isolation can block phone access. Local readiness checks do not prove phone reachability.
- API or Expo port conflicts require stopping the unrelated process or choosing another port. Runner never kills processes by port or executable name, and never adopts unknown processes.
- If Laravel fails, check API logs, PHP, Composer dependencies, `.env`, database access, and cached configuration. Runner does not clear Laravel caches.
- If Expo shows a stale API URL, stop and restart Expo, then fully reload the app.
- A force-closed Runner or OS shutdown may leave service processes alive. Runner reports occupied ports on next start and never kills stale PIDs automatically.
- Open **Consoles** to view API and Expo output separately. Each console has pause/resume and clear controls, and can dock right or expand full screen.

The dashboard binds to loopback. Control requests use same-origin session and CSRF checks. Logs are bounded in memory and redact common credential patterns, but application output may still contain sensitive text. Use Runner only on a trusted development machine.

## Commands

```sh
npm start       # launch dashboard
npm run check   # check setup without starting Laravel or Expo
npm test        # run unit and process-tree tests
```

## Current limits

Runner starts one configured local Laravel API and one Expo project. It does not select remote backends, build/sign/install APKs, start databases, queues, or Redis, run migrations, clear caches, or validate full login and tenant flows. API readiness currently means its port is listening. Phone access and app login still depend on project configuration and network setup.
