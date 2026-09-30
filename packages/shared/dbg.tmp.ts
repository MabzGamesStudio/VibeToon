import { readdirSync, readFileSync, statSync } from 'node:fs';
import { computeSignature, flowStatus } from './src/index';
const dir = '../../data/projects';
const rows = readdirSync(dir).map((p) => ({ p, t: statSync(`${dir}/${p}/project.json`).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 4);
for (const { p } of rows) {
  const project = JSON.parse(readFileSync(`${dir}/${p}/project.json`, 'utf8'));
  for (const node of project.nodes) {
    if (node.kind !== 'animation.video.shots') continue;
    console.log(p, project.name, node.name, flowStatus(project, node), 'cuts', node.data.cuts?.length, 'clips', node.data.clips, 'recorded', String(node.data.recorded).slice(0, 40));
    console.log(' last', node.lastRun?.signature?.slice(0, 200));
    console.log(' now ', computeSignature(project, node).slice(0, 200));
  }
}
