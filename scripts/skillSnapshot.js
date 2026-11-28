// scripts/skillSnapshot.js - 스킬이 의존하는 조문의 공식 본문 지문(시행일·원문 해시)을 기록한다.
//
// 스킬의 점검·요건 트리는 작성 당시 조문 문언에 기대므로, 그 문언을 해시로 남겨 두어야
// 법령이 개정되었을 때 실행 시점에 감지할 수 있다(server/skills/skillStaleness.js).
// 해시는 근거 등록부(evidenceRegistry)가 조문에 붙이는 textHash와 같은 방식이다.
//
// 실행 (국가법령정보센터 API를 호출한다. LAW_OC 필요):
//   node scripts/skillSnapshot.js                    # 모든 스킬의 authorities.json 갱신
//   node scripts/skillSnapshot.js labor-work-rules   # 한 스킬만
//   node scripts/skillSnapshot.js --print 근로기준법 53  # 조문 원문 확인(요건 트리 작성용)
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from '../server/env.js';
import { searchLaw, getLawDetail } from '../server/law/lawApiClient.js';
import { findLawByName } from '../server/law/lawWorkbench.js';
import { articleText } from '../server/law/evidence.js';
import { normalizeArticleNo } from '../server/law/lawArticleRef.js';
import { SKILLS_DIR, articleHash } from '../server/skills/skillLoader.js';

if (!ENV.LAW_OC) {
  console.error('LAW_OC가 설정되지 않았습니다. 공식 본문 없이 지문을 기록할 수 없습니다.');
  process.exit(1);
}

const lawCache = new Map();
async function loadLaw(name) {
  if (lawCache.has(name)) return lawCache.get(name);
  const match = await findLawByName({ searchLaw }, name);
  const detail = match ? await getLawDetail(match.lawId, match.lawSeq, { enforceDate: match.enforceDate }) : null;
  lawCache.set(name, detail?.articles?.length ? detail : null);
  return lawCache.get(name);
}
const findArticle = (detail, articleNo) => {
  const wanted = normalizeArticleNo(articleNo);
  return detail.articles.find(a => normalizeArticleNo(a.fullArticleNo || String(a.articleNo)) === wanted && !/삭제/.test(a.content || '')) || null;
};

const args = process.argv.slice(2);
if (args[0] === '--print') {
  const detail = await loadLaw(args[1]);
  if (!detail) { console.error(`${args[1]} 조회 실패`); process.exit(1); }
  const article = findArticle(detail, args[2]);
  if (!article) { console.error(`${args[1]} 제${args[2]}조 없음`); process.exit(1); }
  console.log(`${detail.lawName} 제${article.fullArticleNo || article.articleNo}조(${article.title || ''}) 시행 ${article.enforceDate || detail.enforceDate}`);
  console.log(`textHash ${articleHash(articleText(article))}`);
  console.log(articleText(article));
  process.exit(0);
}

const targets = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && (!args.length || args.includes(d.name))).map(d => d.name);
let failures = 0;
for (const id of targets) {
  const file = path.join(SKILLS_DIR, id, 'authorities.json');
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const law of data.laws || []) {
    if (law.snapshotPolicy === 'NONE') continue;
    const detail = await loadLaw(law.lawName);
    if (!detail) { console.warn(`[${id}] ${law.lawName} 조회 실패`); failures++; continue; }
    law.snapshot = {};
    for (const no of law.articles) {
      const article = findArticle(detail, no);
      if (!article) { console.warn(`[${id}] ${law.lawName} ${no} 본문 없음`); failures++; continue; }
      law.snapshot[no] = { title: article.title || '', enforceDate: article.enforceDate || detail.enforceDate || null,
        textHash: articleHash(articleText(article)) };
    }
  }
  data.snapshotAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`[${id}] 지문 기록 완료`);
}
if (failures) { console.error(`조회 실패 ${failures}건`); process.exitCode = 2; }
