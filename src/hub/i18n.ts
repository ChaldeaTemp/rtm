import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_LOCALE, matchLocale, translate } from "../ui/locale.js";

const requestLocale = new AsyncLocalStorage<string>();
const processLocale = matchLocale(process.env.RTM_LANG) ?? DEFAULT_LOCALE;

export const HUB_MESSAGES: Record<string, readonly [string, string]> = {
  boardNudgeSummary: ["任务还没报告交付，已提醒主导", "Task not reported yet; the lead was reminded"],
  boardResumeSummary: ["已让主导继续这个任务", "The lead was asked to continue this task"],
  invalidGateOutputPattern: [
    "步骤「{1}」的门禁正则无效：{2}",
    "Invalid gate regex pattern for step \"{1}\": {2}",
  ],
};

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
  if (Object.hasOwn(HUB_MESSAGES, key)) {
    const entry = HUB_MESSAGES[key];
    const template = getLocale() === "en" ? entry[1] : entry[0];
    return template.replace(/\{([1-9]\d*)\}/g, (placeholder, index) => (
      Number(index) <= values.length ? String(values[Number(index) - 1] ?? "") : placeholder
    ));
  }
  return translate(getLocale(), key, ...values);
}
