---
id: privacy-processing
name: 개인정보 처리현황 점검
kind: domain
version: 0.2.0
presets: [privacy_security]
documentTypes: []
keywords: [개인정보, 처리현황, 민감정보, 주민등록번호, 위탁, 국외 이전, 보유기간, 암호화]
stages: [collect, s1-coverage, s4-checks, s7]
lawSnapshot: 2026-11-28
expertReviewed: null
status: shadow
---

## S4 점검 지침
표의 한 행은 하나의 처리 건이다. 그 행의 기재 내용만 보고 답한다.

## 사실 질문 안내
- 민감정보·고유식별정보: 법령상 처리 근거 또는 별도 동의서가 있는지
- 국외 이전: 이전 사실 고지와 동의, 이전받는 자·국가 확인
- 위탁: 위탁 계약서와 처리방침 공개 여부

## 작성 메모
점검은 개인정보 보호법 조문에서 출발해 행(ROW) 단위로 썼다. 기존 행 범위 판정(server/reasoning/privacyCoverage.js)은 그대로 두고, 점검 적중 행을 쟁점과 잇는다.
법률 전문가 검수 전이므로 status는 shadow다.
