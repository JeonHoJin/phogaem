# GitHub Pages

공개 주소: **https://jeonhojin.github.io/phogaem/**

GitHub Pages는 GitHub Actions 배포 소스를 사용한다. `main`에 푸시하면 `.github/workflows/check.yml`에서 다음 순서로 검사하고, 모두 성공한 빌드만 배포한다.

1. 고정된 lockfile로 의존성 설치, high/critical 취약점 감사.
2. 린트, Node 단위 테스트, 모델 호출 없는 Python 실험 도구 테스트.
3. 운영 HTTPS 게이트웨이를 지정해 정적 빌드.
4. Chromium의 로컬 브라우저 시나리오와 실제 배포 빌드의 CSP·사진 왕복 테스트.
5. `dist/`만 Pages 아티팩트로 올리고 배포.

PR은 검사만 수행한다. Pages 쓰기와 OIDC 권한은 배포 작업에만 부여한다. 모델 추론, R2 사용, mlhops 서버 재배포는 이 워크플로에서 수행하지 않는다. 정적 경로는 `/phogaem/`이며 서버 인증 정보는 빌드에 넣지 않는다.

보안 보강 내용과 아직 남은 경계는 [보안 점검 기록](security.md)을 참고한다.

## 접속과 인증

첫 화면은 브라우저의 기기 보관함을 열며 서버 계정을 만들지 않는다. 공유보관함 연결에서 기존 패스키로 승인된 mlhops 계정에 로그인한다. Pages origin과 WebAuthn RP는 기존 `jeonhojin.github.io` 앱과 같다. 계정 승인은 기존 관리 화면에서 수행한다.

로컬 DB·사진·기기 키·테스트 출력·모델 캐시는 Git에서 제외한다. 공개 사이트에는 정적 앱 빌드만 포함되며 서버 사진은 승인된 계정의 인증 요청을 통해 받는다.

## 첫 배포 검증

로컬과 GitHub Actions에서 단위 테스트 22개, Python 도구 테스트 10개, 브라우저 시나리오 11개와 린트·타입 검사·빌드가 통과했다. 운영 API에서 Pages origin의 업로드 사전 요청 허용, 미로그인 목록 요청의 401, 패스키 RP `jeonhojin.github.io`를 확인했다.

공개 페이지의 HTTP 200, 정적 자산 경로, 초기 서버 호출 없음, 패스키 버튼, 모바일 레이아웃을 브라우저에서 점검한다. 실제 사용자 패스키 로그인과 승인 계정의 사진 왕복은 사용자 기기에서 확인한다. 검증을 위해 운영 계정을 자동 승인하지 않는다.
