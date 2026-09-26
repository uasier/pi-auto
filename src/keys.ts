export const JEV_KEY_STORAGE = "pi-auto-jev-key";
export const DEEPSEEK_KEY_STORAGE = "pi-auto-deepseek-key";
export const LAYA_KEY_STORAGE = "pi-auto-laya-key";
export const JEV_BASE_STORAGE = "pi-auto-jev-base";
export const DEEPSEEK_BASE_STORAGE = "pi-auto-deepseek-base";
export const LAYA_BASE_STORAGE = "pi-auto-laya-base";

import { $ } from "./dom";

export type DecisionProvider = "jev" | "deepseek" | "laya";

export function keyStorage(provider: DecisionProvider | string = "jev") {
  if (provider === "deepseek") return DEEPSEEK_KEY_STORAGE;
  if (provider === "laya") return LAYA_KEY_STORAGE;
  return JEV_KEY_STORAGE;
}

export function baseStorage(provider: DecisionProvider | string = "jev") {
  if (provider === "deepseek") return DEEPSEEK_BASE_STORAGE;
  if (provider === "laya") return LAYA_BASE_STORAGE;
  return JEV_BASE_STORAGE;
}

export function providerBase(provider: DecisionProvider | string = "jev") {
  return localStorage.getItem(baseStorage(provider))?.trim() || null;
}

export function keyInput(provider: DecisionProvider | string) {
  return $<HTMLInputElement>(`key-${provider}`);
}
