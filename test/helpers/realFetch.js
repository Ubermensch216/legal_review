// test/helpers/realFetch.js
// setup.js는 전역 fetch를 막아 단위 테스트가 실수로 외부망을 타지 않게 한다.
// 로컬 테스트 서버(가짜 Ollama 등)에는 원래 구현이 필요하므로,
// 이 모듈을 setup.js보다 먼저 import해서 원본을 붙잡아 둔다.
export const realFetch = globalThis.fetch;
