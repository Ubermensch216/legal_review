// server/law/tools/articleAt.js
import { getLawArticle } from '../lawApiClient.js';
import { normalizeArticleNo } from '../lawArticleRef.js';
import { articleText } from '../evidence.js';

export async function execute(params = {}, dependencies = {}) {
  const { lawName, articleNo, paragraphNo = '', itemNo = '' } = params;
  if (!lawName || !articleNo) throw new Error('lawName과 articleNo가 필요합니다.');

  const normArtNo = normalizeArticleNo(articleNo);
  const detail = await (dependencies.getLawArticle || getLawArticle)(lawName, normArtNo);

  if (!detail || !detail.article) {
    return { found: false, message: '조문을 찾을 수 없습니다.' };
  }

  const art = detail.article;
  let targetText = articleText(art);
  let matchedParagraph = null;
  let matchedItem = null;

  if (paragraphNo && art.paragraphs && art.paragraphs.length > 0) {
    matchedParagraph = art.paragraphs.find(p => p.paragraphNo === String(paragraphNo));
    if (matchedParagraph) {
      targetText = matchedParagraph.content;
      if (itemNo && matchedParagraph.items && matchedParagraph.items.length > 0) {
        matchedItem = matchedParagraph.items.find(i => i.itemNo === String(itemNo));
        if (matchedItem) {
          targetText = `${matchedParagraph.content}\n${matchedItem.itemNo}. ${matchedItem.content}`;
        }
      }
    }
  }

  if ((paragraphNo && !matchedParagraph) || (itemNo && !matchedItem)) {
    return { found: false, message: '요청한 항 또는 호를 확인하지 못했습니다.' };
  }
  return {
    found: true,
    lawName: detail.lawName,
    source: detail.source,
    isMockData: detail.isMockData,
    lawSeq: detail.lawSeq,
    articleNo: normArtNo,
    title: art.title,
    paragraphNo,
    itemNo,
    extractedText: targetText,
    fullContent: articleText(art)
  };
}

export default { execute };
