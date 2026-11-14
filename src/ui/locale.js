import { messages } from "./messages.js";

export const DEFAULT_LOCALE = "zh-CN";
export const SUPPORTED_LOCALES = ["zh-CN", "en"];

/** @param {string | undefined} language */
export function matchLocale(language) {
  const base = language?.trim().toLowerCase().split("-")[0];
  if (base === "zh") return "zh-CN";
  if (base === "en") return "en";
  return undefined;
}

/**
 * @param {string} locale
 * @param {string} key
 * @param {...unknown} values
 */
export function translate(locale, key, ...values) {
  const entry = Object.hasOwn(messages, key) ? messages[key] : undefined;
  const template = (locale === "en" ? entry?.[1] : undefined) ?? entry?.[0] ?? key;
  return template.replace(/\{([1-9]\d*)\}/g, (placeholder, index) => (
    Number(index) <= values.length ? String(values[Number(index) - 1] ?? "") : placeholder
  ));
}

/**
 * @param {string} locale
 * @param {{title: string, defaultTitleNumber?: number | null}} group
 */
export function taskTitle(locale, group) {
  return typeof group.defaultTitleNumber === "number"
    ? translate(locale, "numberedTask", group.defaultTitleNumber)
    : group.title;
}

/**
 * @param {string} locale
 * @param {{role: string, senderLabel?: string}} message
 */
export function messageSender(locale, message) {
  const label = message.senderLabel || "";
  if (message.role === "system" && label === "系统") return translate(locale, "system");
  if (message.role === "user" || message.role === "caller") {
    if (label === "你") return translate(locale, "you");
    const handoff = label.match(/^(.+) 交接$/);
    if (handoff) return translate(locale, "handoffFrom", handoff[1]);
    const delegated = label.match(/^(.+) 委派$/);
    if (delegated) return translate(locale, "delegatedBy", delegated[1]);
  }
  return label;
}

/**
 * @param {string} locale
 * @param {{role: string, text: string, leadHandoff?: [string, string]}} message
 */
export function messageText(locale, message) {
  if (message.role !== "system") return message.text;
  const handoff = message.leadHandoff ?? message.text.match(/^主导已交接：(.+) → (.+)$/)?.slice(1);
  return handoff ? translate(locale, "leadChanged", ...handoff) : message.text;
}
