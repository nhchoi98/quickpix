import { QuickPix, QuickPixEasy } from "quickpix";

export const qp = new QuickPix({
  // 기본 동작: quickpix가 번들러 환경에서 가능한 worker 소스를 자동 탐색
  requireWorker: false,
});

export const qpe = new QuickPixEasy({
  // `requireWorker: true`로 바꾸면 실패 시 즉시 에러 처리
  // (기본은 워커 실패 시 메인스레드 폴백)
  requireWorker: false,
});
