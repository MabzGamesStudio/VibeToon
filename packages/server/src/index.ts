import { createApp } from './app';
import { DATA_ROOT, ensureDir, PROJECTS_ROOT } from './paths';
import { hasFfmpeg } from './render/video';

const port = Number(process.env.PORT ?? 5174);

await ensureDir(PROJECTS_ROOT);

createApp().listen(port, () => {
  console.log(`[vibetoon] api on http://localhost:${port}`);
  console.log(`[vibetoon] projects in ${DATA_ROOT}`);
  console.log(`[vibetoon] video render: ${hasFfmpeg() ? 'ffmpeg found' : 'ffmpeg not installed (timelines only)'}`);
});
