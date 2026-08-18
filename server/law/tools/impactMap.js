// server/law/tools/impactMap.js - 조문 인용 충돌, 개정 영향 및 현행 법령 적합성 분석기
import { extractArticleReferences } from '../lawArticleRef.js';
import { searchLaw, getLawArticle, getLawDetail } from '../lawApiClient.js';
import { LAW_TERM_KB } from '../lawTermKb.js';

export async function execute(params = {}) {
  const { documentText = '', targetLaw = '' } = params;
  const fullText = documentText || '';

  // 1. 문서/질의 내 명시적 조문 인용구 추출
  let refs = extractArticleReferences(fullText, targetLaw);
  const impactItems = [];

  // 2. 명시적 인용구가 없는 경우: 도메인 핵심 조문 자동 보충
  if (refs.length === 0 && targetLaw) {
    for (const domain of Object.values(LAW_TERM_KB.domainLaws)) {
      const matchedLaw = domain.find(l => l.name === targetLaw || targetLaw.includes(l.name));
      if (matchedLaw && matchedLaw.mainArticles) {
        matchedLaw.mainArticles.slice(0, 5).forEach(artStr => {
          const m = artStr.match(/제?\s*(\d+)(?:의(\d+))?조?/);
          if (m) {
            refs.push({
              fullRef: `${targetLaw} ${artStr}`,
              lawName: targetLaw,
              articleNo: parseInt(m[1], 10),
              branchNo: m[2] ? parseInt(m[2], 10) : 0,
              fullArticleNo: m[2] ? `${m[1]}의${m[2]}` : `${m[1]}`
            });
          }
        });
        break;
      }
    }
  }

  // 3. 각 조문의 현행 유효성 및 개정 상태 실시간 검증
  for (const ref of refs.slice(0, 10)) {
    const lawName = ref.lawName || targetLaw;
    if (!lawName) continue;

    // 구법/폐지 조문 패턴 감지 (예: 구 개인정보 보호법, 2014년 이전 구법 등)
    const isOldLawMentioned = fullText.includes(`구 ${lawName}`) || fullText.includes('구법') || fullText.includes('종전 규정');

    try {
      const artResult = await getLawArticle(lawName, ref.articleNo, ref.branchNo);
      if (artResult && artResult.article) {
        const isDeleted = artResult.article.isDeleted || false;
        let riskLevel = 'NORMAL';
        let note = '현행 유효 조문과 일치하며 적법성 검토 기준 조항입니다.';

        if (isDeleted) {
          riskLevel = 'HIGH';
          note = '인용된 조문이 현재 법령상 삭제/폐지된 상태이므로 즉시 개정 조문으로 대체해야 합니다.';
        } else if (isOldLawMentioned) {
          riskLevel = 'HIGH';
          note = '개정 전 구법 규정으로 인용되었을 가능성이 있으므로 현행 신법 조항으로 정비가 필요합니다.';
        }

        impactItems.push({
          citation: ref.fullRef || `${lawName} 제${ref.fullArticleNo}조`,
          lawName: artResult.lawName || lawName,
          articleNo: ref.fullArticleNo,
          articleTitle: artResult.article.title || '주요 조항',
          isDeleted,
          currentTextSnippet: artResult.article.content ? (artResult.article.content.slice(0, 160) + '...') : '',
          riskLevel,
          note
        });
      } else {
        impactItems.push({
          citation: ref.fullRef || `${lawName} 제${ref.fullArticleNo}조`,
          lawName,
          articleNo: ref.fullArticleNo,
          articleTitle: '확인 필요',
          isDeleted: false,
          riskLevel: 'CAUTION',
          note: '공식 법령 데이터베이스에서 해당 조문 번호가 직접 확인되지 않아 소관 부처 확인이 권장됩니다.'
        });
      }
    } catch {
      // ignore
    }
  }

  const highRiskCount = impactItems.filter(i => i.riskLevel === 'HIGH').length;
  const cautionCount = impactItems.filter(i => i.riskLevel === 'CAUTION').length;

  return {
    analyzedReferencesCount: refs.length,
    impactSummary: {
      total: impactItems.length,
      highRiskCount,
      cautionCount,
      overallStatus: highRiskCount > 0 ? 'WARNING_DETECTED' : (cautionCount > 0 ? 'CAUTION_DETECTED' : 'CLEAR')
    },
    impactItems
  };
}

export default { execute };
