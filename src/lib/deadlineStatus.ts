export type DeadlineStatus = "always_open" | "closed" | null;

/** 상시/수시채용 등 마감일 없는 공고인지 */
export function isAlwaysOpenDeadline(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return /상시|수시|채용\s*시|충원\s*시|채용시\s*마감/.test(trimmed);
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
