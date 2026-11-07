# Google 로그인

Phogaem은 mlhops 공통 인증의 Google OAuth를 사용한다. Google 로그인은 패스키와 별도의 로그인 수단이며, 신규 계정은 기존과 동일하게 관리자 승인이 필요하다. Google 이름·이메일은 보관함 닉네임을 대체하지 않는다.

## 기존 계정 연결

기존 기기 계정으로 공유보관함에 접속한 뒤 관리 화면의 `Google 연결`을 선택한다. 패스키가 등록된 계정은 해당 계정의 패스키로 다시 확인한다. 이메일이 같아도 계정을 자동으로 합치지 않으며, 이미 다른 계정에 연결된 Google 계정은 거절한다.

새 기기에서는 `Google로 로그인`으로 연결된 계정을 되찾는다. 기존 계정을 연결하기 전에 로그인하면 별도의 미승인 계정이 생성될 수 있으므로 운영 전 연결 순서를 확인한다.

## 운영 설정

서버 설정은 mlhops의 `docs/google-login.md`를 따른다. 기본 서버 파일은 `~/.config/mlhops/google-oauth.json`이며 소유자만 읽고 쓸 수 있는 0600 권한을 사용한다. 프런트에는 client secret·Google 토큰·서비스 계정 키를 넣지 않는다.

Google Cloud 콘솔에서 웹 애플리케이션 OAuth 클라이언트를 만들고 다음 URI를 정확히 등록한다.

```
https://168-107-32-199.sslip.io/auth/google/callback
```

이 방식에는 Google JavaScript SDK나 승인된 JavaScript 원본 등록이 필요하지 않다. 위 sslip.io 주소의 Google 콘솔 수락·브랜드 도메인 검증은 실제 콘솔에서 확인해야 한다. 자체 도메인이 필요한 경우 서버 redirect URI와 콘솔 설정을 함께 바꾼다.

서버의 허용 return URL은 `https://jeonhojin.github.io/phogaem/`이다. core와 gateway를 먼저 배포하고, 실제 Google 왕복을 확인한 뒤 Phogaem 저장소의 공개 Actions 변수 `GOOGLE_LOGIN_ENABLED=true`를 설정해 Pages를 빌드한다. 로컬 기본값과 운영 변수 미설정 시 Google 버튼은 숨겨진다. 버튼 공개만으로 서버 기능이 활성화되지는 않는다.

## 검증

```
npm test
npm run test:google
npm run test:e2e
npm run build
```

`test:google`은 별도 5174 포트의 Vite 서버에서 기능을 켜고 합성 Google 응답만 사용한다. 실제 Google·운영 계정·R2에는 연결하지 않는다. 로그인 시작의 지연 실행, PKCE·기기 서명, 초대 복원, 잘못된 state, 취소 후 이전 계정 자동 참여 방지를 검증한다.

로그인 중의 state·verifier와 기기 키 지문만 경로별 sessionStorage에 최대 10분간 저장한다. callback 코드는 React가 실행되기 전에 주소에서 제거한다. JWT는 메모리에만 유지하며, 실패 시 기존 기기 키를 바꾸지 않는다. 다른 탭에서 기기 계정이 바뀌면 로그인 완료 전후의 지문 검사로 오래된 흐름을 거절한다.

설치형 iOS PWA에서 Google 왕복 후 원래 창·sessionStorage가 유지되는지는 실기기 검증이 필요하다. Safari와 설치된 PWA의 로그인 저장소 공유를 가정하지 않는다. 검증값을 찾을 수 없으면 로그인은 실패하며 검증을 우회하지 않는다.

## 근거

로그인 버튼은 Google이 제공한 아이콘 전용 버튼 SVG를 변형하지 않고 사용한다. 출처는 [공식 에셋 패키지](https://developers.google.com/static/identity/images/signin-assets.zip)의 `Android + Web/SVG/Light/Theme=Light, Show text=No, Shape=Square, Platform=Android+Web.svg`이다. 접근성 이름으로 로그인과 연결 동작을 구분한다. [Google 브랜딩 지침](https://developers.google.com/identity/branding-guidelines)을 따른다.

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google 서버 OAuth 및 redirect URI 검증](https://developers.google.com/identity/protocols/oauth2/web-server#redirect-uri-validation)
- [Google ID token 검증](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Apple 웹앱 OAuth 탐색 동작](https://developer.apple.com/videos/play/wwdc2023/10120/)
- [WebKit 웹앱 저장소 분리](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/#web-apps)
