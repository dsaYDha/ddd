// 프로덕션 빌드를 HTML 파일 하나로 묶는다 (JS·CSS 인라인) — 서버 없이 열거나 다른 곳에 올릴 때
//   npm run build && node scripts/build-single.mjs [출력경로] [--fragment]
//   --fragment: <html>/<head>/<body> 없이 본문만 출력 (외부에서 문서 뼈대를 씌우는 호스팅용)
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const fragment = args.includes('--fragment');
const out = args.find((a) => !a.startsWith('--')) || 'dist/jungle.html';
const dist = 'dist';
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const jsFile = html.match(/<script type="module" crossorigin src="\/([^"]+)"><\/script>/)[1];
const cssFile = html.match(/<link rel="stylesheet" crossorigin href="\/([^"]+)">/)[1];
const js = fs.readFileSync(path.join(dist, jsFile), 'utf8').replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(dist, cssFile), 'utf8');
const title = html.match(/<title>([^<]*)<\/title>/)[1];
const body = `<title>${title}</title>
<style>${css}</style>
<div id="app"></div>
<div id="ui"></div>
<script type="module">${js}</script>
`;
const doc = fragment ? body : `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" href="data:," />
${body}</head>
<body></body>
</html>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, doc);
console.log(`${out} (${(doc.length / 1024).toFixed(0)} KB)`);
