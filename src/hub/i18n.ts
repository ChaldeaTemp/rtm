import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_LOCALE, matchLocale, translate } from "../ui/locale.js";

const requestLocale = new AsyncLocalStorage<string>();
const processLocale = matchLocale(process.env.RTM_LANG) ?? DEFAULT_LOCALE;

export function negotiateLocale(header?: string): string {
  const preferences = (header ?? "").split(",").map((entry) => {
    const [language, ...parameters] = entry.trim().split(";");
    const quality = parameters.find((part) => part.trim().startsWith("q="));
    return { locale: matchLocale(language), weight: quality === undefined ? 1 : Number(quality.trim().slice(2)) };
  });
  preferences.sort((a, b) => b.weight - a.weight);
  return preferences.find(({ locale, weight }) => locale && weight > 0 && weight <= 1)?.locale ?? DEFAULT_LOCALE;
}

export function getLocale(): string {
  return requestLocale.getStore() ?? processLocale;
}

export function withLocale<T>(locale: string, callback: () => T): T {
  return requestLocale.run(locale, callback);
}

export function t(key: string, ...values: unknown[]): string {
  return translate(getLocale(), key, ...values);
}
