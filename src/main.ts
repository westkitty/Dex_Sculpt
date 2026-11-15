import './styles.css';
import { StudioViewport } from './app/viewport';
import { CharacterSession } from './app/characterSession';
import { SculptTool } from './app/sculptTool';
import { StudioUI } from './ui/studioUi';

async function bootstrap(): Promise<void> {
  const appEl = document.getElementById('app');
  if (!appEl) throw new Error('Missing #app root element');

  const stageHost = document.createElement('div');
  const vp = new StudioViewport(stageHost);
  const session = new CharacterSession(vp);

  vp.onFrame = (dt) => {
    session.tickFrame(dt);
  };

  const tool = new SculptTool(
    vp,
    () => session.sculptTargets,
    (entry) => session.history.push(entry),
    () => session.ensureBindPoseForSculpting()
  );

  const ui = new StudioUI(appEl, vp, session, tool);

  // Expose deterministic test/inspection hook for automated Playwright verification
  (window as any).__DEX_SCULPT__ = {
    viewport: vp,
    session,
    tool,
    ui
  };

  const recovered = await session.tryRecoverAutosave();
  if (!recovered) {
    await session.loadProceduralSample();
  }
}

bootstrap().catch((err) => {
  console.error('DEX//SCULPT initialization failed:', err);
});
