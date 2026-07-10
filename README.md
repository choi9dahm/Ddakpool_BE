# Ddakpool API (Backend)

Fastify API 서버 — 채용공고 URL 파싱, 스냅샷 저장, 태그 분류

## 시작하기

```bash
cp .env.example .env
# .env에 Supabase 키 입력
npm install
npm run dev
```

기본 포트: `4000`

## 환경변수

| 변수 | 설명 |
|------|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Key |
| `CORS_ORIGIN` | 허용할 프론트엔드 URL. 여러 개는 쉼표 구분 (예: `http://localhost:3000,https://your-app.vercel.app`) |
| `CORS_ALLOW_VERCEL` | `true`면 `*.vercel.app` 도메인도 허용 (기본 권장) |
| `PORT` | API 포트 (기본 4000) |

## DB 마이그레이션

`supabase/migrations/` SQL을 Supabase SQL Editor에서 실행하세요.

## 헬스체크

```bash
curl http://localhost:4000/health
# {"ok":true}
```

## Render 배포

| 설정 | 값 |
|------|-----|
| Root Directory | *(비워두기 — backend 단독 repo)* |
| Build Command | `npm install` |
| Start Command | `node dist/index.js` |

> `postinstall` 스크립트가 `npm install` 직후 `tsc`로 `dist/`를 자동 생성합니다.  
> Start Command는 `node dist/index.js` 또는 `npm start` 모두 사용 가능합니다.

배포 후에도 같은 에러가 나면 Render → **Settings → Clear build cache & deploy** 를 실행하세요.

### CORS 설정 (필수)

Render **Environment**에 아래 변수를 추가하세요.

| 변수 | 예시 |
|------|------|
| `CORS_ORIGIN` | `http://localhost:3000,https://pm6-final-group-10-fe.vercel.app` |
| `CORS_ALLOW_VERCEL` | `true` |

로컬과 배포를 함께 쓰려면:
`CORS_ORIGIN=http://localhost:3000,https://pm6-final-group-10-fe.vercel.app`
