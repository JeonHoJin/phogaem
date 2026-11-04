# Gemma 4 E4B 이미지 분석 실험

2026-11-04. mlhops가 사용하는 기존 로컬 LM Studio의 `google/gemma-4-e4b`로 실제 추론을 수행했다. 모델은 MLX·4bit·16,384 컨텍스트로 로드되어 있었고 native 모델 목록에 `vision: true`, reasoning `off/on` 지원이 확인되었다. 모델을 다운로드하거나 서버 설정·모델 관리 API를 변경하지 않았다. Cloudflare 호출도 없다.

결과 원본에서 추린 공개 가능한 합성 데이터와 측정값은 [results.json](experiments/gemma-vision/results.json)에 있다. 실제 여행 사진은 사용하지 않았다. 원시 응답·로컬 캐시는 `.local/gemma-vision/`에 남긴다.

## 확인한 결과

합성 그림은 최초 6장: 해변 원본, JPEG 재압축본, 소폭 크롭, 사람 수를 바꾼 연속 장면, 구도가 다른 해변, 산 풍경. 이후 새로운 해변 그림 1장을 추가했다. 그림 안에는 정답 문구나 파일 이름을 넣지 않았다.

| 항목 | 실측 결과 |
|---|---|
| 이미지 입력 | 해변·사람 2명·빨강/흰색 파라솔 인식 성공 |
| 개별 특징 JSON | 최초 6장 모두 파싱·검증 성공. 사람 수 2/2/2/3/2/0 확인 |
| 특징 추출 시간 | 장당 3.718~5.812초, 중앙값 5.138초 |
| 같은 6장 다시 입력 | 분석 캐시 6회 적중, 추론 호출 0회 |
| 새 그림 1장 추가 | 이전 6장 캐시 재사용, 새 그림만 추론 1회, 6.362초 |
| 두 이미지 직접 비교 | JPEG 재압축·크롭을 같은 원본으로 판단, 사람 수 변경을 다른 순간으로 구분 |
| 저장된 설명만 비교 | JPEG·크롭도 ‘비슷한 장면’으로 판단. 동일 원본 여부를 충분히 복원하지 못함 |
| 어려운 반례 | 구도가 다른 두 해변을 직접 보여줘도 `similar_scene`으로 묶음. 배치가 다르다는 설명은 했지만 기대한 `different` 분류에는 실패 |

작은 합성 표본의 동작 실험이다. 실사진 정확도·표정 판단·유사도 임계값·대규모 처리량을 검증한 결과는 아니다. 특히 ‘같은 장소’와 ‘같은 순간’의 구분은 추가 실사진 검증이 필요하다. 자동 삭제·완전 중복 통합의 근거로 사용하지 않는다.

## 실행 설정에서 발견한 점

기본 reasoning on + 출력 256토큰은 17.163초 동안 추론 문구만 생성하고 `length`로 끝나 최종 답이 비었다. native `/api/v1/chat`의 요청별 `reasoning: off`, `store: false`로 바꾸자 짧은 이미지 설명은 2.173초에 끝났다. 서버 전역 기본값을 바꾼 것은 아니다.

Gemma는 비교 결과를 JSON 코드펜스로 감싸기도 했다. 처음 엄격한 JSON 파서는 이를 거절했고, 최종 파서는 **전체 응답이 단일 JSON 코드펜스일 때만** 제거한 뒤 JSON·스키마를 검증한다. 설명문·추론문·여러 객체·잘린 응답은 여전히 실패다. 최초 비교 원문을 다시 추론하지 않고 최종 파서로 오프라인 정규화한 것이 공개 결과 파일이며, 최초 파서 성공 여부와 래퍼 종류도 함께 기록했다.

## 사전 분석을 저장하는 방향

업로드를 기다리게 하지 않고 서버의 단일 백그라운드 작업자가 사진마다 한 번 분석하는 방향이 적합하다. 이번에는 실험용 내용 기반 캐시까지만 구현했으며 실제 업로드 작업 큐·DB 마이그레이션·자동 UI 연결은 하지 않았다.

사진별 보관 후보 값:

- SHA-256: 같은 파일을 확실하게 판별하고 기존 분석을 재사용하는 키.
- 이미지 지각 해시: 가벼운 후보 검색용. 동일 파일을 증명하는 값은 아니다.
- Gemma 분석 JSON: 장면·사람 수·물체·배치·눈에 띄는 차이.
- 모델 식별자/실제 모델 버전·전처리 버전·프롬프트 버전·분석 상태.

새 사진은 자신만 분석하고, **같은 보관함 안에서** 기존 특징으로 후보를 좁힌 뒤 애매한 후보만 원본 두 장으로 비교한다. 모든 이전 사진을 매번 다시 분석하거나 모든 쌍을 LLM으로 비교하지 않는다. 실패·대기 상태의 사진도 보관함에서 숨기지 않는다.

설명 JSON은 이미지 임베딩이 아니다. 단어 선택이 달라지고 작은 시각 정보가 누락될 수 있으므로 JSON 문자열의 해시나 모델이 임의로 생성한 숫자 배열을 이미지 지문처럼 사용하지 않는다. 대규모 벡터 검색을 도입한다면 실제 이미지 임베딩 추출기를 별도로 검증해야 한다.

이번 64bit dHash에서도 사람 수가 달라진 그림의 거리가 0이었고, 구도가 다른 해변은 거리 7, JPEG 재압축은 5였다. 단일 해시 거리만으로 중복을 확정할 수 없다는 반례다. 이 표본으로 임계값을 정하지 않는다.

캐시 키는 현재 이미지 바이트 SHA·모델 ID·프롬프트 버전·생성 설정이다. 같은 모델 별칭 아래 가중치나 양자화를 교체하면 캐시를 무효화해야 한다. 실제 업로드에 연결할 때는 모델 버전과 전처리까지 명시적으로 포함한다.

## 재현

LM Studio에서 해당 모델이 이미 준비된 상태에서 실행한다. 기본 주소는 loopback뿐이며 실험이 모델을 설치·관리하지 않는다.

```sh
npm run probe:fixtures
npm run test:vision
npm run probe:vision

python3 scripts/vision-probe.py \
  --fixtures .local/gemma-vision/fixtures/manifest.json \
  --descriptors-only --output .local/gemma-vision/cache-replay.json

python3 scripts/vision-probe.py \
  --fixtures .local/gemma-vision/fixtures/incremental-manifest.json \
  --descriptors-only --output .local/gemma-vision/incremental-results.json
```

`probe:fixtures`는 기존 Playwright의 Chrome/Chromium으로 로컬 canvas 그림을 생성한다. Python 실험과 테스트는 표준 라이브러리만 사용한다. `test:vision`은 모델을 호출하지 않는 10개 회귀 테스트다. 실제 추론은 `probe:vision`에서만 한다. 응답을 캐시하려면 완전한 JSON·스키마 검증을 통과해야 하며, 타임아웃이면 후속 추론을 중단하고 부분 결과를 남긴다.

## 공식 동작 근거

- [Gemma 이미지 이해](https://ai.google.dev/gemma/docs/capabilities/vision/image): E4B 이미지 입력과 여러 이미지 입력.
- [LM Studio native chat](https://lmstudio.ai/docs/developer/rest/chat): 이미지 `data_url`, 요청별 `reasoning`, `store`와 출력 배열.
- [모델 목록](https://lmstudio.ai/docs/developer/rest/list): 모델별 vision·reasoning 기능 확인.
