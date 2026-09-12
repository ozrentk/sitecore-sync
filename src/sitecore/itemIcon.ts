import { Buffer } from "node:buffer";

export const maximumItemIconBytes = 128 * 1024;
export const maximumConfiguredIconLength = 2_048;

const themePathPrefix = "/sitecore/shell/themes/";
const standardThemePathPrefix = `${themePathPrefix}standard/`;
const supportedExtensions = new Set([".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp"]);
const supportedMediaTypes = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export function resolveSitecoreThemeIconUrl(
  serverUrl: string,
  configuredIcon: string,
): URL | undefined {
  const value = configuredIcon.trim().replaceAll("\\", "/");
  if (
    !value ||
    value.length > maximumConfiguredIconLength ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith("//")
  ) {
    return undefined;
  }

  const server = new URL(serverUrl);
  let resolved: URL;
  try {
    if (/^[a-z][a-z\d+.-]*:/iu.test(value)) {
      resolved = new URL(value);
    } else if (value.startsWith("~/")) {
      resolved = new URL(value.slice(1), server);
    } else if (value.startsWith("/")) {
      resolved = new URL(value, server);
    } else {
      const segments = value.split("/");
      if (segments.some((segment) => segment === "." || segment === "..")) {
        return undefined;
      }
      resolved = new URL(`${standardThemePathPrefix}${value}`, server);
    }
  } catch {
    return undefined;
  }

  const path = resolved.pathname.toLowerCase();
  const extensionStart = path.lastIndexOf(".");
  const extension = extensionStart >= 0 ? path.slice(extensionStart) : "";
  if (
    resolved.protocol !== "https:" ||
    resolved.origin !== server.origin ||
    resolved.username ||
    resolved.password ||
    resolved.search ||
    resolved.hash ||
    /%(?:2e|2f|5c)/iu.test(path) ||
    !path.startsWith(themePathPrefix) ||
    !supportedExtensions.has(extension)
  ) {
    return undefined;
  }
  return resolved;
}

export async function readItemIconDataUri(response: Response): Promise<string> {
  if (!response.ok) {
    throw new Error(`Sitecore item icon request failed (${response.status}).`);
  }
  if (response.redirected) {
    throw new Error("Sitecore item icon request was redirected.");
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType || !supportedMediaTypes.has(mediaType)) {
    throw new Error("Sitecore item icon response did not contain a supported raster image.");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (!Number.isFinite(declaredBytes) || declaredBytes < 0 || declaredBytes > maximumItemIconBytes) {
      throw new Error("Sitecore item icon response exceeded the size limit.");
    }
  }
  if (!response.body) {
    throw new Error("Sitecore item icon response did not contain image data.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumItemIconBytes) {
        await reader.cancel();
        throw new Error("Sitecore item icon response exceeded the size limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!totalBytes) {
    throw new Error("Sitecore item icon response did not contain image data.");
  }
  return `data:${mediaType};base64,${Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("base64")}`;
}
