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
| `CORS_ORIGIN` | 프론트엔드 URL (예: `http://localhost:3000`) |
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
| Start Command | `npm start` |

> `npm start`는 `tsx src/index.ts`로 실행되어 **빌드(`dist/`) 없이** 바로 구동됩니다.  
> Render 대시보드에서 Start Command가 `node dist/index.js`로 되어 있다면 **`npm start`로 변경**하세요.

배포 후에도 같은 에러가 나면 Render → **Settings → Clear build cache & deploy** 를 실행하세요.
