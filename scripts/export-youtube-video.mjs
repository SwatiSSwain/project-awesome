
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.env.ANIMATION_URL || 'https://swatisswain.github.io/project-awesome/';
const speed = String(process.env.PLAYBACK_SPEED || '7');
const width = 1920, height = 1080;
const introHoldMs = 5000;
const maxRunMs = 8 * 60 * 1000;
mkdirSync('export', { recursive: true });

const browser = await chromium.launchPersistentContext('export/chrome-profile', {
  headless: false,
  viewport: { width, height },
  deviceScaleFactor: 1,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-position=0,0', '--window-size=1920,1080', '--app=' + url, '--kiosk']
});
const page = browser.pages()[0] || await browser.newPage();
page.on('pageerror', err => console.error('Browser error:', err.message));
page.on('console', msg => { if (msg.type() === 'error') console.error('Page console:', msg.text()); });
let recorder;
let completed = false;

async function state() {
  return page.evaluate(() => {
    const intro = document.querySelector('#story-intro');
    const ending = document.querySelector('#story-ending');
    const play = document.querySelector('#story-play-silent');
    const playPause = [...document.querySelectorAll('button')].find(b => b.id?.includes('play-pause'));
    return {
      introClass: intro?.className ?? null,
      endingClass: ending?.className ?? null,
      endingDisplay: ending ? getComputedStyle(ending).display : null,
      endingVisibility: ending ? getComputedStyle(ending).visibility : null,
      endingOpacity: ending ? getComputedStyle(ending).opacity : null,
      introButtonPresent: !!play,
      playPauseText: playPause?.textContent?.trim() ?? null,
      documentVisibility: document.visibilityState,
      title: document.title
    };
  });
}

async function diagnostics(reason) {
  console.error(reason);
  try {
    const snapshot = await state();
    console.error('Diagnostic state:', JSON.stringify(snapshot));
    writeFileSync('export/diagnostics.json', JSON.stringify({ reason, url, speed, snapshot }, null, 2));
    await page.screenshot({ path: 'export/diagnostic-screenshot.png', fullPage: false, timeout: 15000 });
  } catch (err) {
    console.error('Could not capture diagnostics:', err.message);
  }
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.locator('#story-play-silent').waitFor({ state: 'attached', timeout: 120000 });
  await page.addStyleTag({ content: `
    html,body { background:#fff !important; overflow:hidden !important; }
    .main-container { zoom: 1.45 !important; }
    #story-music-options, .story-music-options { visibility:hidden !important; }
    .story-ending-actions, .story-ending-replay { visibility:hidden !important; }
  ` });

  recorder = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-f', 'x11grab', '-framerate', '30', '-video_size', `${width}x${height}`,
    '-i', process.env.DISPLAY || ':99',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'export/recording.mp4'
  ], { stdio: ['pipe', 'ignore', 'inherit'] });
  recorder.on('error', err => console.error('FFmpeg error:', err));

  console.log('Intro: holding 5 seconds. Initial state:', JSON.stringify(await state()));
  await page.waitForTimeout(introHoldMs);

  // Trigger the page's existing click handler without attempting to click an
  // intentionally hidden button. The website remains unchanged.
  await page.locator('#story-play-silent').evaluate(el => el.click());
  console.log('Silent intro choice activated. State:', JSON.stringify(await state()));

  const selected = await page.evaluate(requested => {
    for (const el of document.querySelectorAll('select')) {
      const option = [...el.options].find(o =>
        o.value === requested || o.textContent.trim() === `${requested}×` || o.textContent.trim() === `${requested}x`);
      if (option) {
        el.value = option.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return option.value;
      }
    }
    return null;
  }, speed);
  console.log('Playback speed selected:', selected ?? 'not found (page default)');

  const started = Date.now();
  while (Date.now() - started < maxRunMs) {
    const current = await state();
    console.log(`Progress ${Math.round((Date.now() - started) / 1000)}s:`, JSON.stringify(current));
    if (current.endingClass?.split(/\s+/).includes('is-visible') &&
        current.endingVisibility === 'visible') {
      completed = true;
      break;
    }
    await page.waitForTimeout(15000);
  }
  if (!completed) {
    await diagnostics(`Ending not detected within ${maxRunMs / 60000} minutes`);
    throw new Error('Animation did not reach ending; inspect uploaded diagnostics and screenshot.');
  }
  console.log('Final story card visible. Holding 5 seconds.');
  await page.waitForTimeout(5000);
} catch (err) {
  if (!completed) await diagnostics(`Recording failed: ${err.message}`);
  throw err;
} finally {
  if (recorder && recorder.exitCode === null) {
    recorder.stdin.write('q');
    recorder.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        recorder.kill('SIGINT');
        reject(new Error('FFmpeg did not stop cleanly'));
      }, 30000);
      recorder.once('close', code => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`));
      });
    });
  }
  await browser.close();
}
