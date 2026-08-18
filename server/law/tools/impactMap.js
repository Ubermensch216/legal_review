// server/law/tools/impactMap.js - 조문 인용 충돌, 개정 영향 및 현행 법령 적합성 대조표 엔진
import { extractArticleReferences } from '../lawArticleRef.js';
import { searchLaw, getLawArticle } from '../lawApiClient.js';
import { LAW_TERM_KB } from '../lawTermKb.js';

export async function execute(params = {}) {
  const { documentText = '', targetLaw = '' } = params;
  const fullText = documentText || '';

  // 1. 문서/질의 내 명시적 조문 인용구 추출
  let refs = extractArticleReferences(fullText, targetLaw);
  const impactItems = [];

  // 2. 명시적 인용구가 없는 경우: 소관 도메인 핵심 실무 조문 자동 대조
  if (refs.length === 0 && targetLaw) {
    for (const domain of Object.values(LAW_TERM_KB.domainLaws)) {
      const matchedLaw = domain.find(l => l.name === targetLaw || targetLaw.includes(l.name));
      if (matchedLaw && matchedLaw.mainArticles) {
        matchedLaw.mainArticles.slice(0, 6).forEach(artStr => {
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

    const isOldLawMentioned = fullText.includes(`구 ${lawName}`) || fullText.includes('구법') || fullText.includes('종전 규정');

    try {
      const artResult = await getLawArticle(lawName, ref.articleNo, ref.branchNo);
      if (artResult && artResult.article) {
        const art = artResult.article;
        const isDeleted = art.isDeleted || false;
        
        let status = 'VALID';
        let statusLabel = '현행 유효';
        let riskLevel = 'NORMAL';
        let actionGuide = '현행 법령상 유효한 기준 조항입니다. 본 조항의 법정 요건 및 제한사항을 준수하여 검토를 진행하십시오.';

        if (isDeleted) {
          status = 'DELETED';
          statusLabel = '삭제/폐지';
          riskLevel = 'HIGH';
          actionGuide = '인용된 조문이 법령 개정으로 삭제·폐지되었습니다. 현행 신설 조문 또는 관련 대체 조항으로 즉시 수정해야 합니다.';
        } else if (isOldLawMentioned) {
          status = 'OLD_LAW';
          statusLabel = '구법 인용 의심';
          riskLevel = 'HIGH';
          actionGuide = '개정 전 종전 규정을 인용했을 위험이 있습니다. 최신 개정 조문의 세부 항·호 규정과 일치하는지 재확인이 필요합니다.';
        }

        // 규정 내용 가독성 정제 (문단 번호 및 핵심 요지 추출)
        const cleanContent = (art.content || '')
          .replace(/\s+/g, ' ')
          .trim();
        const snippet = cleanContent.length > 180 ? `${cleanContent.slice(0, 180)}...` : cleanContent;

        impactItems.push({
          citation: ref.fullRef || `${lawName} 제${ref.fullArticleNo}조`,
          lawName: artResult.lawName || lawName,
          articleNo: ref.fullArticleNo,
          articleTitle: art.title ? `제${ref.fullArticleNo}조(${art.title})` : `제${ref.fullArticleNo}조`,
          rawTitle: art.title || '주요 조항',
          isDeleted,
          status,
          statusLabel,
          riskLevel,
          currentTextSnippet: snippet || '공식 법령 조문 본문 참조',
          actionGuide,
          note: actionGuide
        });
      } else {
        impactItems.push({
          citation: ref.fullRef || `${lawName} 제${ref.fullArticleNo}조`,
          lawName,
          articleNo: ref.fullArticleNo,
          articleTitle: `제${ref.fullArticleNo}조 (미확인 조항)`,
          rawTitle: '확인 필요',
          isDeleted: false,
          status: 'CAUTION',
          statusLabel: '조문 확인 필요',
          riskLevel: 'CAUTION',
          currentTextSnippet: '국가법령정보센터 DB에서 해당 조문 번호의 직통 본문이 검색되지 않았습니다.',
          actionGuide: '조문 번호(가지번호 포함)의 오기 또는 자치법규/행정규칙 조항과의 혼동 여부를 확인하십시오.',
          note: '공식 법령 데이터베이스에서 해당 조문을 확인하지 못했습니다.'
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
