export type Locale = {code: string; name: string; messages: Record<string, string>; available: {code: string; name: string}[]};

let locale: Locale = {code: "en", name: "English", messages: {}, available: [{code: "en", name: "English"}]};
const listeners = new Set<() => void>();
export const getLocale = () => locale;
export const subscribeLocale = (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};};
export function setLocale(value: Locale) {locale = value; listeners.forEach(listener => listener());}
export function t(message: string, ...values: unknown[]): string {
  return (locale.messages[message] ?? message).replace(/\{(\d+)\}/g, (token, index) => index < values.length ? String(values[index]) : token);
}
