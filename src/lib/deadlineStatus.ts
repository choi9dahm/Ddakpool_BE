export type DeadlineStatus = "always_open" | "closed" | null;

/**
 * 상시/수시채용 등 마감일 없는 공고인지.
 * - '채용시 마감'/'충원시'는 상시채용 체크 대상이 아님 (P0 오류 케이스).
 * - '상시채용'/'수시채용'/'~ 상시'/'상시 채용중' 등만 매칭.
 */
export function isAlwaysOpenDeadline(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;

  // 채용시·충원시 마감만 있고 상시/수시 신호가 없으면 제외
  if (
    /채용\s*시\s*(마감|까지)?|충원\s*시/.test(trimmed) &&
    !/상시|수시/.test(trimmed)
  ) {
    return false;
  }

  return (
    /상시\s*채용|수시\s*채용|상시채용|수시채용/.test(trimmed) ||
    /마감일\s*[:：]\s*상시/.test(trimmed) ||
    /상시\s*채용중/.test(trimmed) ||
    /~\s*상시\b/.test(trimmed) ||
    /(?:^|[\s·,])상시(?:$|[\s·,])/.test(trimmed) ||
    /(?:^|[\s·,])수시(?:$|[\s·,])/.test(trimmed)
  );
}

/** 파서용: 상시/수시 신호면 저장 직전 변환용 토큰 "상시채용"으로 정규화 */
export function normalizeDeadlineRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (isAlwaysOpenDeadline(trimmed)) return "상시채용";
  return trimmed;
}

export function isPastDeadline(date: string | null | undefined): boolean {
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadline = new Date(date);
  if (Number.isNaN(deadline.getTime())) return false;
  deadline.setHours(0, 0, 0, 0);
  return deadline.getTime() < today.getTime();
}

/**
 * 파싱 결과 → 저장용 마감 필드.
 * - 키 없음 → 공란 + status null
 * - "상시채용" 등 → 공란 + always_open
 * - 마감일 지남 → 날짜 유지 + closed
 */
export function resolveDeadlineFields(
  raw: string,
  date: string | null
): {
  deadline_raw: string;
  deadline_date: string | null;
  deadline_status: DeadlineStatus;
} {
  const trimmed = raw.trim();

  if (isAlwaysOpenDeadline(trimmed)) {
    return {
      deadline_raw: "",
      deadline_date: null,
      deadline_status: "always_open",
    };
  }

  if (!trimmed && !date) {
    return {
      deadline_raw: "",
      deadline_date: null,
      deadline_status: null,
    };
  }

  if (isPastDeadline(date)) {
    return {
      deadline_raw: trimmed,
      deadline_date: date,
      deadline_status: "closed",
    };
  }

  return {
    deadline_raw: trimmed,
    deadline_date: date,
    deadline_status: null,
  };
}
