export const MIN_STUDENT_SECRET_LENGTH = 10;
export const MAX_STUDENT_SECRET_LENGTH = 128;

const COMMON_STUDENT_SECRETS = new Set([
  "1234567890",
  "0987654321",
  "1111111111",
  "password",
  "password1",
  "password12",
  "password123",
  "qwertyuiop",
  "qwerty123",
  "letmein123",
  "welcome123",
  "administrator",
  "administrator1",
  "student123",
  "school123",
  "eduri123",
  "пароль",
  "пароль123",
  "ученик123",
  "школа123",
  "кодовоеслово",
]);
const COMMON_STUDENT_SECRET_PATTERN = /^(?:password|qwerty|letmein|welcome|admin(?:istrator)?|student|school|eduri|пароль|ученик|школа|кодовоеслово)\d{0,6}$/u;

function compactSecret(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

export function newStudentSecretIssue(
  value: string,
  loginName?: string | null,
): string | null {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < MIN_STUDENT_SECRET_LENGTH) {
    return `Минимум ${MIN_STUDENT_SECRET_LENGTH} символов`;
  }
  if (normalized.length > MAX_STUDENT_SECRET_LENGTH) {
    return `Максимум ${MAX_STUDENT_SECRET_LENGTH} символов`;
  }
  const compact = compactSecret(normalized);
  if (
    COMMON_STUDENT_SECRETS.has(compact)
    || COMMON_STUDENT_SECRET_PATTERN.test(compact)
    || /^(.)\1+$/u.test(compact)
    || /^\d{6,}$/u.test(compact)
  ) {
    return "Выберите менее распространённую кодовую фразу";
  }
  if (loginName && compact === compactSecret(loginName)) {
    return "Кодовая фраза не должна совпадать с именем входа";
  }
  return null;
}
