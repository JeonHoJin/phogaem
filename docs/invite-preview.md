# 초대 링크 미리보기

새 초대 링크는 API 서버의 `/op/phogaem-invite-preview/v1?token=...` 주소를 사용한다. 서버가 유효한 초대의 보관함 이름을 읽어 HTML의 `title`과 `og:title`에 `포갬 - 보관함 이름`을 넣는다. 카톡 크롤러는 JavaScript를 실행하지 않아도 제목을 읽을 수 있다.

일반 브라우저는 해당 HTML의 제한된 스크립트로 기존 `https://jeonhojin.github.io/phogaem/#invite=...` 참여 흐름에 진입한다. 로그인·계정 승인·보관함 멤버십 검사는 유지한다. 기존 fragment 링크와 초대 코드 직접 붙여넣기도 지원한다.

미리보기에는 보관함 이름만 공개한다. 사진·멤버 목록은 포함하지 않고 R2에 접근하지 않는다. 토큰 만료·재발급으로 무효가 된 링크에서는 보관함 이름을 제공하지 않는다. 응답은 no-store, no-referrer, noindex 정책을 사용하며 보관함 이름을 HTML 이스케이프한다. 브라우저 이동은 고정된 앱 주소로 제한하고 CSP에 등록한 스크립트만 실행한다.

기존 GitHub Pages fragment 링크는 서버에 초대 토큰이 전달되지 않으므로 보관함별 제목으로 소급 변경할 수 없다. 새 링크를 만들어 다시 공유해야 한다. 이미 보낸 메시지와 카카오 캐시의 정보가 즉시 변경되는 것도 보장하지 않는다. [카카오 공유 디버거 안내](https://developers.kakao.com/docs/ko/tool/common)
