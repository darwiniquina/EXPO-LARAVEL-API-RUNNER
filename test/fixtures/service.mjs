import { spawn } from 'node:child_process';

const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
console.log(`worker pid ${worker.pid}`);
setInterval(() => {}, 1000);
