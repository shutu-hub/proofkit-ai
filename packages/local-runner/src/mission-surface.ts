import type { LocalAdapterName } from "./index.js";

/** Only unambiguous platform words are used to constrain a Mission. */
export function requestedMissionSurfaces(intent: string): LocalAdapterName[] {
  const text = intent.normalize("NFKC").toLowerCase();
  const requested: LocalAdapterName[] = [];
  if (/(?:\bweb\b|网页|网站|浏览器(?:端|页面|测试))/.test(text)) requested.push("web");
  if (/(?:\belectron\b|桌面端|桌面版|桌面应用)/.test(text)) requested.push("electron");
  if (/(?:\bandroid\b|\bios\b|\biphone\b|移动端|手机端|手机应用|安卓)/.test(text)) requested.push("mobile");
  return requested;
}

export function selectMissionSurface(intent: string, explicit?: LocalAdapterName): LocalAdapterName {
  if (explicit) return explicit;
  const requested = requestedMissionSurfaces(intent);
  return requested.length === 1 ? requested[0]! : "web";
}

export function assertMissionSurfaceCoverage(intent: string, scheduled: readonly LocalAdapterName[]): void {
  const missing = requestedMissionSurfaces(intent).filter((surface) => !scheduled.includes(surface));
  if (missing.length) {
    throw new Error(`Requested ${missing.join(", ")} surface is absent from the Mission execution matrix; select a compatible surface or a suite that covers every requested platform`);
  }
}
