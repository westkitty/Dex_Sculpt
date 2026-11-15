/**
 * DEX//SCULPT bootstrap.
 *
 * Everything runs in this tab: no backend, no accounts, no telemetry and no
 * uploads. The studio object is exposed as `window.dexSculpt` so the Playwright
 * suite can drive real workflows (load → sculpt → undo → export → reload).
 */
import './styles.css';
import { Studio } from './app/studio';



function fatal(message: string): void {
  const overlay = document.getElementById('loadingOverlay');
  const text = document.getElementById('loadingText');
  if (text) {
    text.textContent = message;
    text.style.color = '#ff8fa3';
  }
  if (overlay) overlay.hidden = false;
  const bar = document.getElementById('loadingBar');
  if (bar) bar.style.animation = 'none';
  const status = document.getElementById('statusMessage');
  if (status) status.textContent = message;
  console.error('[DEX//SCULPT]', message);
}

async function boot(): Promise<void> {
  const studio = new Studio();
  const host = window as unknown as {
    dexSculpt?: Studio;
    __DEXSCULPT?: Record<string, unknown>;
  };
  host.dexSculpt = studio;
  host.__DEXSCULPT = studio.debugApi();

  let booted = false;
  const timeout = window.setTimeout(() => {
    if (!booted) fatal('The workspace is taking longer than expected to start. Check the console for the first error.');
  }, 20000);

  try {
    await studio.init();
    booted = true;
    window.clearTimeout(timeout);
    const version = document.getElementById('statusVersion');
    if (version) version.textContent = 'v0.1.0 · local-only';
  } catch (error) {
    window.clearTimeout(timeout);
    fatal(`Startup failed: ${(error as Error).message ?? String(error)}`);
  }
}

window.addEventListener('error', (event) => {
  const status = document.getElementById('statusMessage');
  if (status && event.message) status.textContent = `Runtime error: ${event.message}`;
});

window.addEventListener('unhandledrejection', (event) => {
  const status = document.getElementById('statusMessage');
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  if (status) status.textContent = `Unhandled error: ${reason}`;
});

void boot();
