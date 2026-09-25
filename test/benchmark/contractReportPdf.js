// node test/benchmark/contractReportPdf.js <검토 JSON> <출력 PDF>
import fs from 'node:fs';
import { generatePdf } from '../../server/export/exportFiles.js';
import pdfParse from 'pdf-parse';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('검토 JSON 경로와 출력 PDF 경로가 필요합니다.');
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
const pdf = await generatePdf({ title: '계약서 법률검토의견서', reviewData: data });
fs.writeFileSync(output, pdf);
const parsed = await pdfParse(pdf);
const bodyData = structuredClone(data);
delete bodyData.review.appendix;
const bodyPages = (await pdfParse(await generatePdf({ title: '계약서 법률검토의견서', reviewData: bodyData }))).numpages;
const forbidden = /\b(?:merge_type|flag|gavel|rate_review|checklist)\b|^#{1,6}\s|\|\s*-{3,}|\*\*/m;
const match = parsed.text.match(forbidden);
if (match) throw new Error(`PDF에 UI 토큰 또는 원시 Markdown이 남았습니다: ${JSON.stringify(parsed.text.slice(Math.max(0, match.index - 60), match.index + 90))}`);
console.log(JSON.stringify({ pdf: output, pages: parsed.numpages, bodyPages, textChars: parsed.text.length,
  appendix: parsed.text.includes('근거 부록') }, null, 2));
