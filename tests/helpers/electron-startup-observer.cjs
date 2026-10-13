// Loaded only by the test launch's CLI --require, before the real app entry.
// oxlint-disable typescript/no-require-imports -- Synchronous Node --require preload.
const {
  existsSync,
  renameSync,
  unlinkSync,
  watchFile,
  writeFileSync,
} = require('node:fs');

const { app, BrowserWindow } = require('electron');

const factsPath = process.env.PEAR_TEST_STARTUP_FACTS;
if (process.type !== 'browser' || !factsPath) {
  throw new Error(
    'Startup observer requires a test-owned main-process facts path',
  );
}

let published = false;
let visibilityPoll;

function capture(refresh = false) {
  if ((!refresh && published) || !app.isReady()) return;
  const visibleWindow = BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isVisible(),
  );
  if (!refresh && !visibleWindow) return;
  const facts = {
    pid: process.pid,
    userData: app.getPath('userData'),
    visibleWindow,
  };
  const temporary = `${factsPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(facts), { flag: 'wx' });
  renameSync(temporary, factsPath);
  published = true;
  clearInterval(visibilityPoll);
  return true;
}

app.on('browser-window-created', (_event, window) => {
  // Native visibility settles after window creation/show listeners return.
  // Keep the witness native, but sample on the next main-process turn.
  window.on('show', () => setImmediate(capture));
  setImmediate(capture);
});
app.whenReady().then(() => capture());

// Some native backends settle visibility without a usable show event. Poll the
// public native state until the first real visible window, then release it.
visibilityPoll = setInterval(() => capture(), 20);
app.once('will-quit', () => clearInterval(visibilityPoll));

// A request after public page readiness samples current native state. Removing
// it acknowledges that the atomic facts publication has completed.
const requestPath = `${factsPath}.request`;
// Poll the exact owned path: directory watch events can omit a filename.
watchFile(requestPath, { interval: 20 }, () => {
  if (!existsSync(requestPath)) return;
  if (capture(true)) unlinkSync(requestPath);
});
