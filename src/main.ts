import { Engine } from './audio/engine';
import { ParamBus } from './state/params';
import { mountApp } from './ui/app';
import { installShortcuts } from './ui/shortcuts';
import { initMIDI } from './audio/midi';
import { Presets } from './state/preset';

async function boot() {
  const overlay = document.getElementById('overlay')!;
  const startBtn = document.getElementById('start-btn')!;

  const start = async () => {
    startBtn.removeEventListener('click', start);
    startBtn.removeEventListener('pointerdown', start);

    const bus = new ParamBus();
    const engine = new Engine(bus);
    await engine.init();

    mountApp(document.getElementById('app')!, engine, bus);
    installShortcuts(engine, bus);
    initMIDI(engine, bus);

    Presets.ensureFactoryPresets();
    const basic = Presets.factory()['basic'];
    if (basic) Presets.apply(bus, basic);

    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 300);
  };

  startBtn.addEventListener('pointerdown', start, { once: true });
}

boot().catch((err) => {
  console.error(err);
  alert('WebSynth failed to start: ' + (err as Error).message);
});
