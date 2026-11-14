import { DEFAULT_LOCALE, SUPPORTED_LOCALES, matchLocale, messageSender, messageText, taskTitle, translate } from "./locale.js";

const STORAGE_KEY = "agent-hub-locale";
const localizedAttributes = ["title", "placeholder", "aria-label", "alt"];
let preference = "";

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (SUPPORTED_LOCALES.includes(saved)) preference = saved;
} catch {
  // Storage can be disabled in the browser profile.
}

export function getLocale() {
  return preference || globalThis.navigator?.languages?.map(matchLocale).find(Boolean) || DEFAULT_LOCALE;
}

export function getLanguagePreference() {
  return preference;
}

export function setLanguagePreference(value) {
  preference = SUPPORTED_LOCALES.includes(value) ? value : "";
  try {
    if (preference) localStorage.setItem(STORAGE_KEY, preference);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The preference still applies for this window.
  }
}

export function t(key, ...values) {
  return translate(getLocale(), key, ...values);
}

// Interpolation values and the translation are both plain text, including in attributes.
export function th(key, ...values) {
  return t(key, ...values)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function displayTaskTitle(group) {
  return taskTitle(getLocale(), group);
}

export function displayMessageSender(message) {
  return messageSender(getLocale(), message);
}

export function displayMessageText(message) {
  return messageText(getLocale(), message);
}

export function localizeDocument() {
  document.documentElement.lang = getLocale();
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const attr of localizedAttributes) {
    const source = `data-i18n-${attr}`;
    for (const element of document.querySelectorAll(`[${source}]`)) {
      element.setAttribute(attr, t(element.getAttribute(source)));
    }
  }
}

export function apiFetch(input, options) {
  const headers = new Headers(options?.headers);
  headers.set("Accept-Language", getLocale());
  return fetch(input, { ...options, headers });
}
