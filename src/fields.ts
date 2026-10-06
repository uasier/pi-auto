import { $ } from "./dom";
import { keyStorage, type DecisionProvider } from "./keys";

export const JEV_PROVIDER_STORAGE = "pi-auto-jev-provider";

export const loopRoundsInput = () => $<HTMLInputElement>("loop-rounds");
export const idleMsInput = () => $<HTMLInputElement>("idle-ms");
export const commitAfterInput = () => $<HTMLInputElement>("commit-after");
export const compactAtInput = () => $<HTMLInputElement>("compact-at");
export const jevOnInput = () => $<HTMLInputElement>("jev-on");
export const jevMaxInput = () => $<HTMLInputElement>("jev-max");
export const jevProviderInput = () => $<HTMLSelectElement>("jev-provider");

export function jevProvider(): DecisionProvider {
  const value = jevProviderInput().value;
  return value === "deepseek" || value === "laya" ? value : "jev";
}

export function providerLabel(provider = jevProvider()) {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "laya") return "Laya";
  return "Jev";
}

export function providerKey(provider = jevProvider()) {
  return localStorage.getItem(keyStorage(provider))?.trim() || "";
}
