// test/benchmark/goldSet.js - 정답셋 채점기
//
// 정답셋(gold/cases.json)은 사례마다 기대 조문·반드시 다뤄야 할 쟁점·내려서는 안 되는 결론을 적는다.
// 이 채점기는 검토 결과가 그것과 얼마나 맞는지 재서 모델·프롬프트·코드를 바꿨을 때의 후퇴를 잡는다.
// 정답셋이 전문가 검수를 받기 전(expertReviewed=null)에는 점수를 법리 정확도로 읽지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCitations } from './scoring.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const loadGoldSet = (file = path.join(dir, 'gold/cases.json')) => JSON.parse(fs.readFileSync(file, 'utf8'));

const issueText = issue => `${issue.question || ''} ${issue.research?.queries?.join(' ') || ''}`;

/** 쟁점이 기대 쟁점을 다뤘는가: 키워드 묶음 중 하나라도 모든 단어가 쟁점 문장에 있으면 다룬 것이다. */
export const coversIssue = (expected, issues) =>
  issues.some(issue => expected.keywords.some(group => group.every(word => issueText(issue).includes(word))));

/**
 * @param {object} review 검토 결과(review.reasoning 포함)
 * @param {object} gold 정답셋의 사례 하나
 * @returns {{ citation, issueCoverage, forbidden, judged, expertReviewed }}
 */
export function scoreAgainstGold(review, gold) {
  const issues = review.reasoning?.issues || [];
  const citation = scoreCitations(review, gold.expectedArticles, gold.baseLaw);
  const cited = (review.legalBasis || []).map(b => String(b.articleNo || '').trim());
  const citedMust = gold.mustCite.filter(article => cited.some(b => b.startsWith(article)));
  const covered = gold.expectedIssues.filter(expected => coversIssue(expected, issues));
  const forbidden = (gold.mustNotConclude || []).flatMap(rule => issues
    .filter(issue => rule.issueKeywords.every(word => issueText(issue).includes(word)) && rule.legal.includes(issue.conclusion?.legal))
    .map(issue => ({ issueId: issue.id, legal: issue.conclusion.legal, reason: rule.reason })));
  const judged = issues.filter(i => ['OK', 'OK_WITH_WARNINGS', 'PARTIAL'].includes(i.stageStatus) && (i.assessments || []).length > 0).length;
  return {
    citation: { recall: citation.recall, precision: citation.precision, mustCited: `${citedMust.length}/${gold.mustCite.length}`, missed: citation.missed },
    issueCoverage: { covered: covered.length, expected: gold.expectedIssues.length,
      missing: gold.expectedIssues.filter(e => !covered.includes(e)).map(e => e.label) },
    forbidden,
    judged: { issues: issues.length, judged, rate: issues.length ? Number((judged / issues.length).toFixed(2)) : 0 },
    expertReviewed: gold.expertReviewed
  };
}
