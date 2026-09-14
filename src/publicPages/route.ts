export function suggestRoute(itemPath: string, siteRootPath?: string): string {
  const itemSegments = pathSegments(itemPath);
  const rootSegments = siteRootPath ? pathSegments(siteRootPath) : [];
  const belongsToSite = rootSegments.length > 0 &&
    itemSegments.length >= rootSegments.length &&
    rootSegments.every((segment, index) =>
      segment.localeCompare(itemSegments[index], undefined, { sensitivity: "base" }) === 0
    );
  let routeSegments = belongsToSite
    ? itemSegments.slice(rootSegments.length)
    : itemSegments.slice(-1);
  let homeIndex = -1;
  for (let index = routeSegments.length - 1; index >= 0; index -= 1) {
    if (routeSegments[index].localeCompare("home", undefined, { sensitivity: "base" }) === 0) {
      homeIndex = index;
      break;
    }
  }
  if (homeIndex >= 0) {
    routeSegments = routeSegments.slice(homeIndex + 1);
  }
  const localDataIndex = routeSegments.findIndex((segment) =>
    segment.localeCompare("data", undefined, { sensitivity: "base" }) === 0
  );
  if (localDataIndex > 0) {
    routeSegments = routeSegments.slice(0, localDataIndex);
  }
  const slugSegments = routeSegments.map(slugSegment).filter(Boolean);
  return slugSegments.length ? `/${slugSegments.join("/")}` : "/";
}

function pathSegments(value: string): readonly string[] {
  return value.trim().replace(/\\/gu, "/").split("/").filter(Boolean);
}

function slugSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

