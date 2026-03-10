# quickpix

[English](./README.md)

고성능 브라우저/Node.js 이미지 리사이즈 라이브러리.
Rust/WASM SIMD 가속 + 순수 JS fallback. pica 대비 **2~5배 빠른** 리사이즈 성능.

```bash
npm install quickpix
```

## 빠른 시작 — 고수준 API (`QuickPixEasy`)

대부분의 사용 사례에서는 `QuickPixEasy`만으로 충분합니다.
Blob/File 입력 → 리사이즈 → Blob 출력을 한 번의 호출로 처리합니다.

```js
import { QuickPixEasy } from "quickpix";

const qp = new QuickPixEasy({
  filter: "lanczos",           // 리사이즈 필터 (기본: bilinear)
  outputMimeType: "image/jpeg",
  outputQuality: 0.85,
  preserveMetadata: true,      // EXIF/ICC/IPTC 메타데이터 보존
  autoRotate: true,            // EXIF Orientation 자동 보정 (기본: true)
});
```

### Blob/File 리사이즈

```js
// 파일 input에서 받은 이미지를 리사이즈
const input = document.querySelector('input[type="file"]');
const file = input.files[0];

const resized = await qp.resizeBlob(file, 1200, 800);
// resized는 Blob — 바로 URL.createObjectURL() 또는 FormData에 사용 가능

// resizeFile은 resizeBlob의 별칭
const resized2 = await qp.resizeFile(file, 1200, 800);
```

### 썸네일 생성

종횡비를 자동으로 보존합니다. 긴 쪽이 `maxDimension` 이하가 됩니다.

```js
// 6000x4000 이미지 → 200x133 썸네일
const thumbnail = await qp.createThumbnail(file, 200);

// Canvas, ImageData, HTMLImageElement도 입력 가능
const thumb2 = await qp.createThumbnail(canvasElement, 150);
```

### Canvas에 직접 출력

```js
const canvas = document.getElementById("preview");
canvas.width = 800;
canvas.height = 600;

await qp.resizeToCanvas(file, canvas, { filter: "lanczos" });
// canvas에 리사이즈된 이미지가 그려짐
```

### 배치 병렬 처리

여러 이미지를 Web Worker 풀에서 동시에 처리합니다.
각 이미지가 별도 워커에서 decode→resize→encode 전체 파이프라인을 수행합니다.

```js
const results = await qp.batchResize([
  { source: photo1, maxDimension: 800 },
  { source: photo2, width: 600, height: 400 },
  { source: photo3, maxDimension: 200 },
]);
// results = [Blob, Blob, Blob]
```

### 메타데이터 보존

기본적으로 Canvas API를 거치면 EXIF, ICC 프로필 등 메타데이터가 모두 제거됩니다.
`preserveMetadata: true`로 설정하면 원본 JPEG의 메타데이터를 결과에 재삽입합니다.

```js
// 메타데이터 보존 (EXIF 촬영일, GPS, 카메라 정보, ICC 색상 프로필 등)
const withMeta = await qp.resizeBlob(photo, 1200, 800, {
  preserveMetadata: true,
  outputMimeType: "image/jpeg",
});

// 메타데이터 제거 (기본값 — 개인정보 보호에 유리)
const stripped = await qp.resizeBlob(photo, 1200, 800, {
  preserveMetadata: false,
});
```

### EXIF Orientation 자동 보정

스마트폰 사진은 EXIF에 회전 정보를 저장합니다.
`autoRotate: true`(기본값)이면 자동으로 올바른 방향으로 보정합니다.

```js
// autoRotate: true (기본값) — 세로 촬영 사진이 올바르게 회전됨
const rotated = await qp.resizeBlob(phonePhoto, 800, 600);

// autoRotate: false — 원본 픽셀 방향 그대로 (회전 안 함)
const raw = await qp.resizeBlob(phonePhoto, 800, 600, { autoRotate: false });
```

### Fit 모드

```js
// contain (기본): 800x600 안에 들어가도록 축소, 종횡비 보존
const a = await qp.resizeBlob(photo, 800, 600, { fit: "contain" });

// cover: 800x600을 완전히 덮도록 확대, 종횡비 보존 (잘릴 수 있음)
const b = await qp.resizeBlob(photo, 800, 600, { fit: "cover" });

// fill: 정확히 800x600으로 변환, 종횡비 무시
const c = await qp.resizeBlob(photo, 800, 600, { fit: "fill" });
```

### 리소스 정리

```js
qp.destroy(); // 워커 풀 종료 및 리소스 해제
```

### 전체 옵션 정리

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `filter` | `"bilinear"` | 리사이즈 필터 (`nearest`, `bilinear`, `box`, `hamming`, `lanczos`) |
| `maxWorkers` | `navigator.hardwareConcurrency` | 워커 풀 최대 크기 |
| `idleTimeout` | `30000` | 유휴 워커 자동 종료 (ms) |
| `outputMimeType` | `"image/png"` | 출력 이미지 형식 |
| `outputQuality` | `0.92` | JPEG/WebP 품질 (0~1) |
| `useWasm` | `true` | WASM 가속 사용 여부 |
| `preserveMetadata` | `false` | EXIF/ICC/IPTC 메타데이터 보존 |
| `autoRotate` | `true` | EXIF Orientation 자동 보정 |

---

## 저수준 API (`QuickPix`)

RGBA 버퍼를 직접 다루거나, 세밀한 제어가 필요할 때 사용합니다.

```js
import { QuickPix } from "quickpix";

const qp = new QuickPix({
  useWasm: true,
  filter: "lanczos",
});

const src = new Uint8ClampedArray(640 * 480 * 4); // RGBA 버퍼
const out = await qp.resizeBuffer(src, 640, 480, 320, 240, {
  filter: "lanczos",
});

console.log(out.width, out.height, out.data.length); // 320 240 307200
```

### 지원 필터

| 필터 | 설명 | 속도 | 품질 |
|---|---|---|---|
| `nearest` | 최근접 픽셀 선택 | 가장 빠름 | 낮음 |
| `bilinear` | 2x2 선형 보간 (기본값) | 빠름 | 중간 |
| `box` | 박스 평균 | 보통 | 중간 |
| `hamming` | 해밍 윈도우 | 느림 | 높음 |
| `lanczos` | Lanczos3 sinc 기반 | 가장 느림 | 최고 |

### Canvas/ImageData 리사이즈

```js
await qp.resize(sourceCanvas, targetCanvas, { filter: "bilinear" });
```

### 통계 확인

```js
const stats = qp.getStats();
// { calls: 10, wasmHits: 8, fallbackHits: 2, lastError: null }
```

---

## 메타데이터 모듈

EXIF/ICC/IPTC를 직접 다뤄야 할 때 독립 모듈로 사용할 수 있습니다.

```js
import { readOrientation, extractSegments, injectSegments } from "quickpix/metadata";

const buffer = await file.arrayBuffer();

// EXIF Orientation 읽기 (1~8)
const orientation = readOrientation(buffer);

// 메타데이터 세그먼트 추출
const segments = extractSegments(buffer);
// { exif: Uint8Array | null, icc: Uint8Array[], iptc: Uint8Array | null }

// 리사이즈된 JPEG에 메타데이터 재삽입
const restored = await injectSegments(resizedJpegBlob, segments);
```

---

## 설치 및 빌드

```bash
npm install quickpix

# 개발 환경 (소스에서 빌드)
npm install
npm run build:wasm    # Rust → WASM 빌드 (wasm-pack 필요)
npm run test:js       # JS 테스트 실행
npm run test:rust     # Rust 테스트 실행
```

## 벤치마크

```bash
npm run bench           # 성능 벤치마크
npm run bench:compare   # pica 대비 비교
npm run bench:memory    # 메모리 프로파일링
npm run bench:native    # sharp(libvips) 대비 비교
npm run bench:quality   # 품질 비교
```

## 프로젝트 구조

```
crates/core/       Rust RGBA 리사이즈 코어 (SIMD)
crates/wasm/       wasm-bindgen 바인딩
js/src/
  index.js         QuickPix 저수준 엔진
  easy.js          QuickPixEasy 고수준 API
  fallback.js      순수 JS 리사이즈 (separable 2-pass)
  metadata.js      EXIF/ICC/IPTC 파서
  decode.js        Blob → RGBA 디코딩
  encode.js        RGBA → Blob 인코딩
  worker-pool.js   재사용 워커 풀
  pipeline-worker.js  전체 파이프라인 워커
bench/             벤치마크 스크립트
```

## 브라우저 호환성

| 기능 | Chrome 69+ | Firefox 105+ | Safari 16.4+ |
|---|---|---|---|
| 파이프라인 워커 (최적) | O | O | O |
| JS fallback | 모든 브라우저 | 모든 브라우저 | 모든 브라우저 |

`OffscreenCanvas` 미지원 환경에서는 자동으로 메인 스레드 경로로 전환됩니다.

## 라이선스

MIT
