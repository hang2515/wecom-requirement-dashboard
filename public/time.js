export function toDateTimeLocal(date, offsetMinutes = -date.getTimezoneOffset()) {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  return local.toISOString().slice(0, 16);
}
