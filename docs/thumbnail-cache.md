# 썸네일 생성·캐시 검토

> 아래는 초기 검토 기록이다. 현재는 Mac Image I/O + cwebp가 WebP를 만들고 R2에 보관하는 실제 경로를 구현했다. 동작·제한·복구는 [후처리](processing.md)를 따른다.

2026-11-05. 검토와 합성 이미지 실험 결과이며, 썸네일 생성·서빙 기능은 아직 구현하지 않았다. 현재 격자는 화면 근처의 원본을 지연 조회하고 Blob URL을 해제한다. 지속적인 썸네일 저장소는 없다.

## 권장 방식

Mac 서버가 원본당 한 번 작은 JPEG를 만들어 디스크에 저장하고 모든 멤버가 재사용한다. 원본 업로드 완료 → 별도 작업 큐 → 썸네일 준비 → 격자에서 썸네일 조회 순서다. 크게 보기·다운로드는 원본을 유지한다. 생성 실패가 원본 업로드를 실패로 바꾸면 안 된다.

초기 후보는 긴 변 최대 640px·JPEG 품질 70, 원본보다 확대하지 않는 설정이다. 이 값은 확정된 품질 기준이 아니며 실제 화면/기기 검증 후 조정한다. 투명도 처리와 HDR/색상 변환도 명시해야 한다. 브라우저에서만 축소하면 각 새 기기가 먼저 원본을 내려받아야 해서 공유 목록의 첫 전송량 문제가 남는다.

현재 Mac에는 `/usr/bin/sips`가 있다. magick·ffmpeg 및 Phogaem의 이미지 디코더 의존성은 없다. 우선 macOS Image I/O 또는 sips를 별도 제한된 변환 프로세스로 검증할 수 있다. 클라우드 이미지 서비스·새 패키지 설치·R2 호출은 이번 검토에서 사용하지 않았다. 서버 CPU·디스크는 사용한다.

## 합성 실험

기존 Gemma 실험의 합성 풍경 PNG만 사용했다. 원본 512×384, 22,919바이트를 sips로 JPEG 품질 70·긴 변 320px로 바꿨다. 결과는 320×240, 10,296바이트로 약 55.1% 작았다. 한 장의 합성 PNG 결과이며 여행 사진의 평균 절감률이나 HEIC 지원 검증으로 일반화하지 않는다.

명령의 `-Z 640`은 이 작은 원본을 640×480으로 확대했고 24,769바이트로 오히려 커졌다. 따라서 운영 구현은 변환 전 원본 크기를 확인하고 `min(목표 크기, 원본 긴 변)`으로 제한해야 한다. 원본 파일은 수정하지 않았다. 실험 출력은 Git에서 제외된 `.local/thumbnail-review/`에 있다.

## 캐시와 권한

- 키: `albumId / 원본 SHA-256 / thumbnail-v1-640-jpeg-q70`. 포맷·크기·품질·방향/색상 처리 변경 시 버전을 바꾼다.
- 중복 작업은 하나로 묶고, 완료 파일을 임시 경로에서 원자적으로 교체한다. 재시작 때 미완성 파일을 성공 캐시로 취급하지 않는다.
- 썸네일 조회에도 매 요청 계정 승인·보관함 멤버십을 검사한다. 해시는 접근 권한이 아니다. 공개 정적 디렉터리로 노출하지 않는다.
- 우선 서버 디스크 캐시만 도입하고 HTTP 응답의 `private, no-store`는 유지한다. 매번 생성하지 않는 효과와 사용자 기기의 영구 저장은 별개다.
- 브라우저는 제한된 메모리 캐시를 검토할 수 있으나 계정/앨범 범위와 승인 재검증·퇴출 기준이 필요하다. IndexedDB/Cache API 영구 캐시는 이번 권장 1차 범위에서 제외한다. 이미 전달한 이미지의 회수는 보장할 수 없다.
- 썸네일이 준비되지 않은 동안 격자는 placeholder를 유지한다. 원본으로 자동 대체해 목록에서 다시 대용량 전송이 발생하지 않게 한다. 사용자가 크게 보기·다운로드를 선택하면 원본을 요청할 수 있다.

## 구현 전 확인

작업 동시성 1개부터 시작하고 바이트·픽셀 수·프레임 수·시간·출력 크기·전체 디스크 용량을 제한한다. 입력 경로는 서버가 생성한 UUID/해시 경로만 사용하고 셸 문자열에 사용자 파일명을 삽입하지 않는다. 이미지 헤더 검사만으로 안전한 디코딩을 보장하지 않는다. 앱 프로세스 밖 변환과 OS 격리 수준을 검증해야 한다.

EXIF 회전, JPEG/PNG/WebP/HEIC, 투명도, HDR/색상, 손상 파일, 작은 압축 파일의 거대 해상도, 중복 동시 요청, 작업 중단·재시작을 합성 데이터로 확인한다. sips 존재만으로 HEIC의 실제 방향·색상·성능을 검증했다고 판단하지 않는다. 원본 EXIF/GPS 등을 썸네일로 그대로 복사하지 않는다. 자동 삭제/원본 정리 도입 시 썸네일도 함께 정리한다.

## 근거

[Apple Image I/O 썸네일 생성](https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/ImageIOGuide/imageio_source/ikpg_source.html)은 최대 픽셀 크기와 방향 변환 옵션을 설명한다. [Image I/O 지원 형식 조회](https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/ImageIOGuide/imageio_basics/ikpg_basics.html)로 대상 OS의 읽기/쓰기 형식을 확인해야 한다.

브라우저 대안은 [createImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap)과 [Canvas toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob)이다. [Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache)는 HTTP 캐시 헤더와 자동 만료에 의존할 수 없으므로 수명·권한을 앱에서 설계해야 한다. [Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control)의 서버 응답 정책과 별도로 판단한다.
