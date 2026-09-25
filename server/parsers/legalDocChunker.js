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
const ARTICLE_START_REGEX = /^(?:###?\s*)?(?:■\s*)?(?:제\s*(?<article>\d+)(?:의(?<legacyBranch>\d+))?\s*조(?:\s*의\s*(?<branch>\d+))?(?:\s*\((?<title>[^)]+)\))?|제\s*(?<sectionNo>\d+)\s*(?<sectionUnit>[장절관])\s*(?<sectionTitle>[^\n\r]*)|\[(?<annex>별표|별지)\]\s*(?<annexTitle>[^\n\r]*))/;

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

// 스프레드시트는 조문 구분자가 없어도 각 데이터 행이 독립된 검토 대상이다.
// CSV 인용부호 안의 쉼표·개행을 보존하여 행의 원문 위치를 추적할 수 있게 한다.
function csvRecords(text) {
  const records = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    } else if (text[i] === '\n' && !quoted) {
      records.push(text.slice(start, i).replace(/\r$/, ''));
      start = i + 1;
    }
  }
  if (start < text.length) records.push(text.slice(start).replace(/\r$/, ''));
  return records;
}

function csvCells(record) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < record.length; i++) {
    if (record[i] === '"') {
      if (quoted && record[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (record[i] === ',' && !quoted) { cells.push(value); value = ''; }
    else value += record[i];
  }
  cells.push(value);
  return cells.map(cell => cell.trim());
}

function spreadsheetChunks(text) {
  const records = csvRecords(text).filter(record => record.trim());
  const source = records[0]?.match(/^\[첨부문서:\s*([^\]]+)\]/)?.[1] || '';
  const first = records.findIndex(record => !/^\[(?:첨부문서|시트):/.test(record.trim()));
  if (first < 0) return [createPreambleChunk(text)];
  const header = csvCells(records[first].replace(/^\uFEFF/, ''));
  if (header.length < 3) return [createPreambleChunk(text)];
  const chunks = [createPreambleChunk(records.slice(0, first + 1).join('\n'))];
  let rowNo = 0;
  for (const record of records.slice(first + 1)) {
    const cells = csvCells(record);
    if (!cells.some(Boolean)) continue;
    const label = cells[0] === '[검토 요청]' ? '검토 요청' : `행 ${++rowNo}`;
    const title = cells[0] === '[검토 요청]' ? '검토 요청'
      : [source, /^\d+$/.test(cells[0]) ? '' : cells[0], cells[1]].filter(Boolean).join(' · ') || label;
    const chunk = { articleNo: label, title, fullHeader: `${label} (${title})`, content: record,
      paragraphs: [], items: [], rawLines: [record], isRiskClause: false, riskTags: [], riskLevel: 'LOW',
      columnNames: header };
    finalizeArticleChunk(chunk);
    chunks.push(chunk);
  }
  return chunks;
}

function isSpreadsheetText(text) {
  const records = csvRecords(text.replace(/^\uFEFF/, '')).filter(record => record.trim()
    && !/^\[(?:첨부문서|시트):/.test(record.trim()));
  if (records.length < 2) return false;
  const columns = csvCells(records[0]).length;
  return columns >= 4 && csvCells(records[1]).length === columns;
}

/**
 * 텍스트 문서를 조항 단위 구조체 배열로 계층적 분할
 * @param {string} text - 원문 텍스트
 * @returns {Array<object>} 계층화된 조항 배열
 */
export function chunkLegalDocument(text) {
  if (!text || typeof text !== 'string') return [];

  // 여러 첨부를 한 문자열로 묶는 API 경로에서도 파일별 행 경계를 유지한다.
  const fileMarkers = [...text.matchAll(/^\[첨부문서:\s*([^\]\r\n]+)\]\s*$/gm)];
  if (fileMarkers.length && fileMarkers.some(match => /\.(?:csv|xlsx|xls)$/i.test(match[1]))) {
    const chunks = [];
    if (fileMarkers[0].index > 0) chunks.push(...chunkLegalDocument(text.slice(0, fileMarkers[0].index)));
    fileMarkers.forEach((match, index) => {
      const block = text.slice(match.index, fileMarkers[index + 1]?.index ?? text.length).trim();
      chunks.push(...(/\.(?:csv|xlsx|xls)$/i.test(match[1]) ? spreadsheetChunks(block) : chunkLegalDocument(block.replace(/^\[첨부문서:[^\n]*\]\s*\n/, ''))));
    });
    return chunks;
  }
  if (isSpreadsheetText(text)) return spreadsheetChunks(text);

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

      const g = artMatch.groups;
      const branch = g.branch || g.legacyBranch;
      const articleNo = g.article ? `제${g.article}조${branch ? '의' + branch : ''}`
        : g.annex ? g.annex : `제${g.sectionNo}${g.sectionUnit}`;
      const title = g.title || g.sectionTitle || g.annexTitle || '조항';

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
