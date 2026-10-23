import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const url = process.env.ANIMATION_URL || 'https://swatisswain.github.io/project-awesome/';
const speed = String(process.env.PLAYBACK_SPEED || '7');
const width = 1920, height = 1080;
const maxRunMs = 20 * 60 * 1000;
const introHoldMs = 5000;
mkdirSync('export', { recursive: true });

const browser = await chromium.launchPersistentContext('export/chrome-profile', { headless: false, viewport: { width, height }, deviceScaleFactor: 1, args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-position=0,0', '--window-size=1920,1080', '--app=' + url, '--kiosk'] });
const page = browser.pages()[0] || await browser.newPage();
page.on('pageerror', err => console.error('Browser error:', err.message));
let recorder;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.locator('#story-play-silent').waitFor({ state: 'visible', timeout: 120000 });
  // The published animation is 600x650. Enlarge it while retaining the same layout.
  await page.addStyleTag({ content: `
    html,body { background:#fff !important; overflow:hidden !important; }
    .main-container { zoom: 1.45 !important; }
  ` });
  // Hide only the website's interactive buttons for the export.
  // Preserve the intro photo and campaign message for five seconds.
  await page.addStyleTag({ content: `
    #story-music-options, .story-music-options { visibility: hidden !important; }
    .story-ending-actions { visibility: hidden !important; }
  ` });
  // Use the silent play choice because FFmpeg adds the licensed soundtrack
  // from the first frame. Record the clean intro before starting the journey.
  recorder = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-f', 'x11grab', '-framerate', '30', '-video_size', `${width}x${height}`,
    '-i', process.env.DISPLAY || ':99',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'export/recording.mp4'
  ], { stdio: ['pipe', 'ignore', 'inherit'] });
  recorder.on('error', e => console.error('FFmpeg failed:', e));
  await new Promise(resolve => setTimeout(resolve, introHoldMs));
  await page.locator('#story-play-silent').click({ force: true });
  // Find the speed dropdown from the animation controls, then select the requested speed.
  const selected = await page.evaluate((speed) => {
    const selects = [...document.querySelectorAll('select')];
    for (const el of selects) {
      const option = [...el.options].find(o => o.value === speed || o.textContent.trim() === `${speed}×` || o.textContent.trim() === `${speed}x`);
      if (option) {
        el.value = option.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return option.value;
      }
    }
    return null;
  }, speed);
  console.log('Playback speed selected:', selected ?? 'not found (using page default)');
  await page.locator('#story-ending.is-visible').waitFor({ timeout: maxRunMs });
  console.log('Final story card visible. Holding 5 seconds.');
  await page.waitForTimeout(5000);
} finally {
  if (recorder && recorder.exitCode === null) {
    recorder.stdin.write('q');
    recorder.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { recorder.kill('SIGINT'); reject(new Error('FFmpeg did not stop cleanly')); }, 30000);
      recorder.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`)); });
    });
  }
  await browser.close();
}
