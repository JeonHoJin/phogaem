# 포갬 · Phogaem

각자의 사진을, 하나의 여행으로.

**[포갬 열기](https://jeonhojin.github.io/phogaem/)**

친구들이 여행 사진을 함께 올리고, 내가 올린 사진·중복 파일·이미 받은 사진을 걸러 필요한 원본만 가져가는 공유보관함. 휴대폰 업로드와 PC·큰 화면 감상을 함께 지원한다.

현재는 **mlhops 공유 통합 버전**이다. 브라우저 전용 보관함과 서버 공유보관함을 선택할 수 있다. 실제 기기 키·패스키 인증, 보관함 생성·초대·멤버별 사진 공유·다운로드 기록이 연결되었다. 운영 백엔드와 GitHub Pages가 배포되었고 모든 공유 API에 관리자 계정 승인이 적용되어 있다. 원본과 WebP 썸네일은 비공개 R2에 저장하며 총 9.5GB 예약 한도를 적용한다. 업로드 후 썸네일·Gemma 작업 상태도 연결되어 있다.

- [아키텍처와 저장소 구조](docs/architecture.md)
- [구현 순서와 완료 기준](docs/plan.md)
- [개발·검증 안내](docs/development.md)
- [화면 디자인 기준](DESIGN.md)
- [사용자 흐름 설계](docs/user-flow.md)
- [mlhops 통합 실행·검증](docs/integration.md)
- [승인 계정 제한과 패스키 공유](docs/approval.md)
- [GitHub Pages 배포](docs/pages.md)
- [Gemma 이미지 분석 실험 결과](docs/vision-experiment.md)
- [썸네일 생성·캐시 검토](docs/thumbnail-cache.md)
- [원본·WebP 썸네일 R2 전환 계획](docs/r2-migration-plan.md)
- [실제 업로드 후처리와 프로세스 수명](docs/processing.md)
- [분석 기반 비교 후보](docs/comparison.md)

## 개발 원칙

- 개발 중 Cloudflare 비용은 쓰지 않는다. 기본 개발·테스트는 로컬 데이터와 파일만 사용한다.
- 생성된 `phogaem-photos` 버킷은 Standard·비공개로 유지한다. 운영 R2 연결은 사용자 지시로 활성화했다. 개발·CI는 기본 로컬이며 R2를 호출하지 않는다.
- 프런트엔드는 정적 웹앱, 인증과 서버 기능은 기존 mlhops를 사용한다.
- 삭제 UI와 자동 만료는 후속 작업이다. 영구 보관 서비스로 안내하지 않는다.
- 실제 여행 사진, 계정별 스토리지 주소, API 키, 인프라 설정은 공개 레포에 넣지 않는다.

설계 기준은 로컬 `../mlhops/docs/new-app.md`와 `../mlhops/docs/contract.md`다. 기존 mlhops 레포·운영 서비스는 이번 초기 구조 작업에서 수정하지 않는다.

## 실행

Node.js 22.18 이상에서 레포 루트 기준:

```sh
npm ci
npm run dev
```

브라우저에서 http://127.0.0.1:5173/phogaem/ 를 연다. 기본 진입은 로그인과 공유보관함 목록이다. 로컬 체험은 ‘기기 보관함’ → ‘올리기’ 또는 ‘샘플’로 연다. 샘플은 합성 풍경 일러스트다.

원본은 현재 브라우저의 IndexedDB에 저장된다. 다른 기기·브라우저에는 나타나지 않고, 사이트 데이터를 지우면 사라질 수 있으므로 원본 파일은 따로 보관한다. 기기 보관함의 ‘미리보기 사용자’는 필터와 다운로드 기록을 시험하는 기능이며 실제 로그인은 아니다. 서버 공유 모드는 명시적으로 연결한 계정을 사용한다.

선택 다운로드 창의 ‘일괄 다운로드’로 원본 하나 또는 ZIP을 내려받는다. ZIP의 원본 합계는 최대 256MiB다. 수령 확인은 다운로드와 별도의 체크 버튼으로 기록하고 되돌릴 수 있다.

## 공유 모드 실행

```sh
npm run dev:server
```

출력된 로컬 게이트웨이 주소를 `VITE_MLHOPS_API_BASE`로 지정해 별도 프런트엔드를 띄운 뒤 **http://localhost:5174/phogaem/** 에서 ‘로그인’ 또는 ‘시작’을 누른다. 정확한 명령·준비물·한도는 [통합 안내](docs/integration.md)에 있다. `npm run test:shared`로 실제 인증·게이트웨이·사이드카 경로를 격리된 DB에서 재현할 수 있다.
