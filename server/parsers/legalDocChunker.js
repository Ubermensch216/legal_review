// server/parsers/legalDocChunker.js - 법률 문서 조항 단위 계층적 청킹 및 위험 조항 태깅 엔진

/**
 * 위험/독소 조항 키워드 룰셋
 */
const RISK_PATTERNS = [
  {
    category: 'CONSENT_BYPASS',
    label: '사전 동의 생략/포괄 동의 의심',
    level: 'HIGH',
    keywords: ['동의 없이', '동의를 생략', '사전 동의를 요하지', '포괄적 동의', '동의한 것으로 본다', '간주한다', '별도 동의 없이']
  },
  {
    category: 'VOICE_RECORDING',
    label: '음성 녹음/사생활 침해 우려',
    level: 'HIGH',
    keywords: ['음성 녹음', '음성녹음', '대화내용을 녹음', '창문 방향', '사생활 침해와 관계없이', '임의로 확대', '줌 기능']
  },
  {
    category: 'IMMUNITY_CLAUSE',
    label: '일방적 손해배상 면책/독소조항',
    level: 'HIGH',
    keywords: ['책임을 일체 부담하지', '책임을 지지 아니', '민·형사상 책임을 면한다', '귀책사유를 불문하고', '이의를 제기할 수 없다', '일체의 손해배상 책임을 지지']
  },
  {
    category: 'EXCESSIVE_PENALTY',
    label: '과도한 위약벌/손해배상 예정',
    level: 'HIGH',
    keywords: ['위약벌', '배액을 배상', '3배', '5배', '과태료 50만원', '즉시 과태료', '몰수한다', '반환하지 아니한다']
  },
  {
    category: 'UNILATERAL_TERMINATION',
    label: '일방적 해지권/청문 생략 처분',
    level: 'HIGH',
    keywords: ['즉시 해지할 수 있다', '최고 없이 해지', '청문 절차 없이', '즉시 등록을 취소', '영업정지를 명할 수 있다']
  },
  {
    category: 'DATA_SHARING',
    label: '개인정보 무단 3자 제공/영구보관',
    level: 'HIGH',
    keywords: ['비식별 조치 없이', '영구 보관', '민간 솔루션 개발', '제3자에게 제공', '암호화 처리를 갈음']
  },
  {
    category: 'ADMIN_CONFLICT',
    label: '상위법령 위임 한계 일탈 의심',
    level: 'MEDIUM',
    keywords: ['법률의 위임 없이', '조례에 따라', '조례로 정한다', '법률 규정에도 불구하고', '규정에도 불구하고']
  }
];

/**
 * 조항 시작 패턴 정규식
 * - 제1조(목적) / 제 1 조 (목적) / 제12조의2(제목) / 제1장 / 제2절 / 1. 조항 등
 */
const ARTICLE_START_REGEX = /^(?:###?\s*)?(?:■\s*)?(?:제\s*(\d+(?:의\d+)?)\s*조(?:\s*\(([^)]+)\))?|(?:제\s*(\d+)\s*[장절관])\s*([^\n\r]*))/;

/**
 * 항(Paragraph) 기호: ① ~ ⑳ 또는 1. 2.
 */
const PARAGRAPH_REGEX = /^(?:[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]|(?:\d+)\.)\s*/;

/**
 * 호(Item) 기호: 1. 2. 3.
 */
const ITEM_REGEX = /^(?:\d+)\.\s*/;

/**
 * 목(Sub-item) 기호: 가. 나. 다. 라.
 */
const SUB_ITEM_REGEX = /^[가-힣]\.\s*/;

/**
 * 텍스트 문서를 조항 단위 구조체 배열로 계층적 분할
 * @param {string} text - 원문 텍스트
 * @returns {Array<object>} 계층화된 조항 배열
 */
export function chunkLegalDocument(text) {
  if (!text || typeof text !== 'string') return [];

  const lines = text.split(/\r?\n/);
  const chunks = [];
  let currentArticle = null;
  let currentParagraph = null;
  let preambleLines = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line) {
      if (currentArticle) {
        currentArticle.rawLines.push(rawLine);
      }
      continue;
    }

    const artMatch = line.match(ARTICLE_START_REGEX);

    if (artMatch) {
      // 이전 조항 마무리
      if (currentArticle) {
        finalizeArticleChunk(currentArticle);
        chunks.push(currentArticle);
      } else if (preambleLines.length > 0) {
        // 조항 시작 전 전문(Preamble)
        const preambleText = preambleLines.join('\n').trim();
        if (preambleText) {
          chunks.push(createPreambleChunk(preambleText));
        }
        preambleLines = [];
      }

      const articleNo = artMatch[1] ? `제${artMatch[1]}조` : (artMatch[3] ? `제${artMatch[3]}장/절` : '');
      const title = artMatch[2] || artMatch[4] || '조항';

      currentArticle = {
        articleNo,
        title: title.trim(),
        fullHeader: line,
        content: '',
        paragraphs: [],
        items: [],
        rawLines: [line],
        isRiskClause: false,
        riskTags: [],
        riskLevel: 'LOW'
      };
      currentParagraph = null;
    } else {
      if (currentArticle) {
        currentArticle.rawLines.push(rawLine);

        // 항/호/목 파싱
        if (PARAGRAPH_REGEX.test(line)) {
          currentParagraph = {
            header: line.slice(0, 3).trim(),
            text: line,
            items: []
          };
          currentArticle.paragraphs.push(currentParagraph);
        } else if (ITEM_REGEX.test(line) && currentParagraph) {
          currentParagraph.items.push(line);
        } else if (SUB_ITEM_REGEX.test(line)) {
          currentArticle.items.push(line);
        }
      } else {
        preambleLines.push(rawLine);
      }
    }
  }

  // 마지막 조항 마무리
  if (currentArticle) {
    finalizeArticleChunk(currentArticle);
    chunks.push(currentArticle);
  } else if (preambleLines.length > 0) {
    const preambleText = preambleLines.join('\n').trim();
    if (preambleText) {
      chunks.push(createPreambleChunk(preambleText));
    }
  }

  return chunks;
}

/**
 * 조항 메타데이터 및 위험 태깅 산출
 */
function finalizeArticleChunk(chunk) {
  chunk.content = chunk.rawLines.join('\n').trim();

  // 위험 룰셋 매칭
  const textToScan = `${chunk.title} ${chunk.content}`;
  const matchedTags = [];
  let highestLevel = 'LOW';

  for (const rule of RISK_PATTERNS) {
    const matchedKeywords = rule.keywords.filter(k => textToScan.includes(k));
    if (matchedKeywords.length > 0) {
      matchedTags.push({
        category: rule.category,
        label: rule.label,
        level: rule.level,
        matchedKeywords
      });

      if (rule.level === 'HIGH') highestLevel = 'HIGH';
      else if (rule.level === 'MEDIUM' && highestLevel !== 'HIGH') highestLevel = 'MEDIUM';
    }
  }

  chunk.riskTags = matchedTags;
  chunk.isRiskClause = matchedTags.length > 0;
  chunk.riskLevel = chunk.isRiskClause ? highestLevel : 'LOW';
  delete chunk.rawLines;
}

/**
 * 전문(Preamble) 청크 생성
 */
function createPreambleChunk(text) {
  const preamble = {
    articleNo: '전문',
    title: '문서 서두 / 제안 이유',
    fullHeader: '전문 및 배경',
    content: text,
    paragraphs: [],
    items: [],
    rawLines: text.split('\n'),
    isRiskClause: false,
    riskTags: [],
    riskLevel: 'LOW'
  };
  finalizeArticleChunk(preamble);
  return preamble;
}

export default {
  chunkLegalDocument,
  RISK_PATTERNS
};
